// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ICreditRegistry {
    function creditScore(address agent) external view returns (uint256);
}

/// @title LaborMarketV2
/// @notice An on-chain labour exchange for AI agents. A requester escrows USDC
///         for a job; a worker whose on-chain credit score clears the job's
///         threshold accepts and delivers it; on approval the escrow is
///         released.
///
///         Money and state live here; human-readable job specs live off-chain,
///         referenced by specHash.
///
/// @dev    THREE CHANGES FROM V1, each answering a documented defect.
///
///         1. TIMEOUTS. V1 had no exit from `Accepted`: a worker who claimed
///            and never delivered froze the requester's funds forever. That is
///            residual risk R1 in docs/security-audit.md, it happened (28 jobs,
///            ~$140), and recovery required the platform to drive the agents'
///            own smart accounts through submitWork -> raiseDispute ->
///            resolveDispute(false). That works and it makes the whole system
///            custodial: a frozen escrow could only be freed by the operator.
///            Both stalls now have permissionless, deadline-gated exits.
///
///         2. ASSIGNABLE RELEASE. A prime contractor escrows its
///            subcontractors before the parent bounty releases, so it needs
///            working capital against collateral that is already visible
///            on-chain. Visible is not the same as seizable: in V1 the release
///            always paid the worker, so a lender could see the collateral and
///            not attach to it. `assignPayee` makes the assignment irrevocable
///            and public, which is what turns observable into perfected.
///
///         3. NO CHANGE TO WHO JUDGES. Timeouts decide only what happens when
///            nobody acts. They never decide that work was good. Release on
///            merit still requires the requester, and a contested job still
///            requires the arbiter.
contract LaborMarketV2 {
    IERC20 public immutable usdc;
    ICreditRegistry public immutable registry;
    address public immutable arbiter;

    enum Status {
        Open,
        Accepted,
        Submitted,
        Completed,
        Cancelled,
        Disputed,
        Refunded
    }

    struct Job {
        address requester;
        address worker;
        uint256 bounty;
        uint256 minScore; // required worker credit score (0 = open to all)
        Status status;
        bytes32 specHash;
        bytes32 resultHash;
        /// @dev Absolute timestamp by which the worker must submit. Set when
        ///      the job is accepted; zero while Open.
        uint64 deliveryDeadline;
        /// @dev Absolute timestamp by which the requester must approve or
        ///      dispute. Set when work is submitted; zero before.
        uint64 reviewDeadline;
        /// @dev How long a worker gets, chosen by the requester at post time.
        uint32 deliveryWindow;
        /// @dev Who the release pays. Zero means the worker. Once set it can
        ///      never change — see assignPayee.
        address payee;
    }

    /// @dev Bounds on the requester-chosen delivery window. A floor because a
    ///      one-second window is a trap that lets a requester reclaim before
    ///      any real work could finish; a ceiling because an unbounded window
    ///      is V1's frozen escrow wearing a number.
    uint32 public constant MIN_DELIVERY_WINDOW = 10 minutes;
    uint32 public constant MAX_DELIVERY_WINDOW = 30 days;

    /// @dev How long the requester has to approve or dispute after delivery.
    ///      Fixed rather than requester-chosen: it protects the WORKER, and a
    ///      value chosen by the party it constrains is not a protection.
    uint32 public constant REVIEW_WINDOW = 7 days;

    uint256 public jobCount;
    mapping(uint256 => Job) public jobs;

    event JobPosted(
        uint256 indexed jobId,
        address indexed requester,
        uint256 bounty,
        uint256 minScore,
        bytes32 specHash,
        uint32 deliveryWindow
    );
    event JobAccepted(uint256 indexed jobId, address indexed worker, uint256 workerScore, uint64 deliveryDeadline);
    event WorkSubmitted(uint256 indexed jobId, bytes32 resultHash, uint64 reviewDeadline);
    event JobCompleted(uint256 indexed jobId, address indexed paidTo, address indexed requester, uint256 bounty);
    event JobCancelled(uint256 indexed jobId);
    event JobDisputed(uint256 indexed jobId, address indexed raisedBy);
    event DisputeResolved(uint256 indexed jobId, bool releasedToWorker);
    /// @dev Emitted so a second lender can see the first lender's claim before
    ///      advancing against the same collateral.
    event PayeeAssigned(uint256 indexed jobId, address indexed worker, address indexed payee);
    /// @dev A worker missed its deadline; escrow returned to the requester.
    event JobReclaimed(uint256 indexed jobId, address indexed formerWorker);
    /// @dev A requester neither approved nor disputed in time.
    event ReviewExpired(uint256 indexed jobId);

    error WrongStatus();
    error NotRequester();
    error NotWorker();
    error NotArbiter();
    error ScoreTooLow(uint256 have, uint256 need);
    error SelfWork();
    error BadWindow();
    error TooEarly(uint64 nowTs, uint64 deadline);
    error PayeeAlreadySet();
    error ZeroPayee();

    constructor(address _usdc, address _registry, address _arbiter) {
        usdc = IERC20(_usdc);
        registry = ICreditRegistry(_registry);
        arbiter = _arbiter;
    }

    /// @notice Post a job, escrowing `bounty` USDC. Requester must approve
    ///         this contract for `bounty` first (batch it in the same UserOp).
    /// @param deliveryWindow How long the accepting worker gets to deliver.
    function postJob(uint256 bounty, uint256 minScore, bytes32 specHash, uint32 deliveryWindow)
        external
        returns (uint256 jobId)
    {
        if (deliveryWindow < MIN_DELIVERY_WINDOW || deliveryWindow > MAX_DELIVERY_WINDOW) revert BadWindow();
        require(usdc.transferFrom(msg.sender, address(this), bounty), "escrow: transferFrom");
        jobId = ++jobCount;
        Job storage job = jobs[jobId];
        job.requester = msg.sender;
        job.bounty = bounty;
        job.minScore = minScore;
        job.status = Status.Open;
        job.specHash = specHash;
        job.deliveryWindow = deliveryWindow;
        emit JobPosted(jobId, msg.sender, bounty, minScore, specHash, deliveryWindow);
    }

    /// @notice Accept an open job. Reputation-gated: the worker's on-chain
    ///         credit score must meet the job's threshold.
    /// @dev    The delivery clock starts here and is readable on-chain, so the
    ///         off-chain warner does not keep a second opinion about when a
    ///         claim expires. Two clocks disagreeing is how the original
    ///         incident happened.
    function acceptJob(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Open) revert WrongStatus();
        if (msg.sender == job.requester) revert SelfWork();

        uint256 score = registry.creditScore(msg.sender);
        if (score < job.minScore) revert ScoreTooLow(score, job.minScore);

        job.worker = msg.sender;
        job.status = Status.Accepted;
        job.deliveryDeadline = uint64(block.timestamp) + job.deliveryWindow;
        emit JobAccepted(jobId, msg.sender, score, job.deliveryDeadline);
    }

    /// @notice Worker submits the deliverable (referenced off-chain by hash).
    /// @dev    A submission that lands in the same block as a reclaim cannot
    ///         double-settle: whichever transaction is mined first moves the
    ///         status, and the second reverts with WrongStatus. Block order is
    ///         the tie-break, not whichever the platform noticed first.
    function submitWork(uint256 jobId, bytes32 resultHash) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Accepted) revert WrongStatus();
        if (msg.sender != job.worker) revert NotWorker();
        job.resultHash = resultHash;
        job.status = Status.Submitted;
        job.reviewDeadline = uint64(block.timestamp) + REVIEW_WINDOW;
        emit WorkSubmitted(jobId, resultHash, job.reviewDeadline);
    }

    /// @notice Requester approves the work; escrow is released.
    function approveJob(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Submitted) revert WrongStatus();
        if (msg.sender != job.requester) revert NotRequester();

        job.status = Status.Completed;
        _release(jobId, job);
    }

    /// @notice Assign the release of this job to another address — a lender
    ///         that advanced the worker the capital to fund its own
    ///         subcontractors.
    /// @dev    Three properties, and they are the entire point:
    ///
    ///         IRREVOCABLE. A revocable assignment is a promise, and the
    ///         borrower already had one of those. This is the property that
    ///         turns observable collateral into perfected collateral.
    ///
    ///         BEFORE SUBMISSION. A lender needs security at the moment it
    ///         advances, not after delivery. Assigning post-submission would
    ///         be a payment instruction, which is not security at all.
    ///
    ///         PUBLIC. The event lets a second lender see the first one's
    ///         claim. Undisclosed double-pledging of one asset is the oldest
    ///         fraud in secured lending.
    ///
    ///         Note what this does NOT protect against: a refund. If the job
    ///         is reclaimed or the dispute goes against the worker, the escrow
    ///         returns to the requester and the lender is unsecured. That is
    ///         execution risk, it is exactly what the LTV in
    ///         lib/orchestration-risk.ts prices, and it is not the contract's
    ///         job to remove.
    function assignPayee(uint256 jobId, address payee) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Accepted) revert WrongStatus();
        if (msg.sender != job.worker) revert NotWorker();
        if (payee == address(0)) revert ZeroPayee();
        if (job.payee != address(0)) revert PayeeAlreadySet();

        job.payee = payee;
        emit PayeeAssigned(jobId, msg.sender, payee);
    }

    /// @notice Requester disputes a submission instead of approving it.
    function raiseDispute(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Submitted) revert WrongStatus();
        if (msg.sender != job.requester) revert NotRequester();

        job.status = Status.Disputed;
        emit JobDisputed(jobId, msg.sender);
    }

    /// @notice Arbiter settles a disputed job: true releases escrow, false
    ///         refunds the requester.
    function resolveDispute(uint256 jobId, bool releaseToWorker) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Disputed) revert WrongStatus();
        if (msg.sender != arbiter) revert NotArbiter();

        if (releaseToWorker) {
            job.status = Status.Completed;
            _release(jobId, job);
        } else {
            job.status = Status.Refunded;
            require(usdc.transfer(job.requester, job.bounty), "refund: transfer");
        }
        emit DisputeResolved(jobId, releaseToWorker);
    }

    /// @notice Requester cancels an unaccepted job and reclaims the escrow.
    function cancelJob(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Open) revert WrongStatus();
        if (msg.sender != job.requester) revert NotRequester();

        job.status = Status.Cancelled;
        require(usdc.transfer(job.requester, job.bounty), "refund: transfer");
        emit JobCancelled(jobId);
    }

    /// @notice The exit from `Accepted` that V1 did not have. Once the delivery
    ///         deadline has passed with nothing submitted, the escrow returns
    ///         to the requester.
    /// @dev    PERMISSIONLESS ON PURPOSE. Any address may call it. Every
    ///         recovery path that requires a specific party is a path where
    ///         that party is an availability risk, and in V1 that party was
    ///         the operator — which is what made the system custodial. A user
    ///         must be able to get their funds back without the operator being
    ///         awake, willing, or still in business.
    ///
    ///         Calling this is not a judgement about the work. It only
    ///         observes that no work arrived before a deadline both sides
    ///         agreed to on-chain.
    function reclaimJob(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Accepted) revert WrongStatus();
        if (block.timestamp < job.deliveryDeadline) revert TooEarly(uint64(block.timestamp), job.deliveryDeadline);

        address formerWorker = job.worker;
        job.status = Status.Refunded;
        require(usdc.transfer(job.requester, job.bounty), "refund: transfer");
        emit JobReclaimed(jobId, formerWorker);
    }

    /// @notice The mirror stall: work was delivered and the requester never
    ///         approved and never disputed. Also permissionless once the
    ///         review window has passed.
    /// @dev    This resolves to a REFUND, and the asymmetry is deliberate
    ///         rather than fair. Paying out on silence would make "submit
    ///         anything and wait" a way to extract escrow without any grader
    ///         ever passing the work — which is the one thing this whole
    ///         system exists to prevent. Refunding on silence instead costs a
    ///         worker who delivered honestly to an absent requester, and that
    ///         cost is real. The trade is accepted because the failure it
    ///         avoids is unbounded and the failure it causes is bounded by one
    ///         bounty, and because an absent requester also stops being able
    ///         to buy anything, so the market prices them out on its own.
    function expireReview(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Submitted) revert WrongStatus();
        if (block.timestamp < job.reviewDeadline) revert TooEarly(uint64(block.timestamp), job.reviewDeadline);

        job.status = Status.Refunded;
        require(usdc.transfer(job.requester, job.bounty), "refund: transfer");
        emit ReviewExpired(jobId);
    }

    /// @dev Single release path, so the payee assignment cannot be honoured on
    ///      one settlement route and forgotten on another. V1 released in two
    ///      places with duplicated logic; this is the same defect shape as the
    ///      off-chain money paths in docs/failure-modes.md.
    function _release(uint256 jobId, Job storage job) private {
        address paidTo = job.payee == address(0) ? job.worker : job.payee;
        require(usdc.transfer(paidTo, job.bounty), "release: transfer");
        emit JobCompleted(jobId, paidTo, job.requester, job.bounty);
    }

    /// @notice Whether `reclaimJob` would succeed right now — for the
    ///         off-chain warner, so it reads the contract's clock instead of
    ///         keeping its own.
    function reclaimable(uint256 jobId) external view returns (bool) {
        Job storage job = jobs[jobId];
        return job.status == Status.Accepted && block.timestamp >= job.deliveryDeadline;
    }

    /// @notice Whether `expireReview` would succeed right now.
    function reviewExpirable(uint256 jobId) external view returns (bool) {
        Job storage job = jobs[jobId];
        return job.status == Status.Submitted && block.timestamp >= job.reviewDeadline;
    }
}
