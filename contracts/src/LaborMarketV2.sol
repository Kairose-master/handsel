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
///
///            **All THREE stalls now have permissionless, deadline-gated
///            exits.** An earlier draft of this contract said "both", and
///            counted wrong: `Accepted` and `Submitted` had exits, and
///            `Disputed` did not. Its only door was `resolveDispute`, callable
///            by an `immutable` arbiter with no setter — so a lost arbiter key
///            froze every contested escrow forever. That is R1 again, in the
///            contract that was written to fix R1, which is the ordinary way
///            this class of bug survives a rewrite: the fix is applied to the
///            states you were thinking about.
///
///         2. ASSIGNABLE RELEASE. A prime contractor escrows its
///            subcontractors before the parent bounty releases, so it needs
///            working capital against collateral that is already visible
///            on-chain. Visible is not the same as seizable: in V1 the release
///            always paid the worker, so a lender could see the collateral and
///            not attach to it. `assignPayee` makes the assignment irrevocable
///            and public, which is what turns observable into perfected — and
///            it assigns an AMOUNT, not the whole cash flow, so securing a
///            lender does not hand it the worker's margin as well.
///
///         3. NO CHANGE TO WHO JUDGES. Timeouts decide only what happens when
///            nobody acts. They never decide that work was good. Release on
///            merit still requires the requester, and a contested job still
///            requires the arbiter — right up until the arbiter is demonstrably
///            not coming.
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
        /// @dev Absolute timestamp by which the arbiter must rule. Set when a
        ///      dispute is raised; zero before.
        uint64 disputeDeadline;
        /// @dev How long a worker gets, chosen by the requester at post time.
        uint32 deliveryWindow;
        /// @dev Who receives `payeeAmount` of the release. Zero means the
        ///      worker takes everything. Once set it can never change — see
        ///      assignPayee.
        address payee;
        /// @dev How much of the bounty the payee takes. Always <= bounty; the
        ///      remainder goes to the worker in the same transaction.
        uint256 payeeAmount;
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

    /// @dev How long the arbiter has to rule on a contested job. Longer than
    ///      the review window because this is the one window a human is meant
    ///      to spend reading a deliverable and an objection. It is a backstop
    ///      against an arbiter that is gone, not a schedule for one that works.
    uint32 public constant DISPUTE_WINDOW = 14 days;

    /// @dev A bounty of zero escrows nothing, and a job that escrows nothing
    ///      still emits JobAccepted and JobCompleted — which is the raw
    ///      material the credit engine scores. Free completions are free
    ///      reputation, so the floor is one unit of the token rather than
    ///      zero. Deliberately ONE UNIT and not a dollar: the mainnet plan
    ///      turns on cent-scale bounties, and a floor that prices out the
    ///      product is a worse bug than the one it prevents.
    uint256 public constant MIN_BOUNTY = 1;

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
    /// @dev `workerAmount` and `payeeAmount` are reported separately because a
    ///      release can now have two recipients. An indexer that reads only a
    ///      single `paidTo` would silently mis-attribute a split settlement.
    event JobCompleted(
        uint256 indexed jobId,
        address indexed worker,
        address indexed requester,
        uint256 bounty,
        address payee,
        uint256 payeeAmount,
        uint256 workerAmount
    );
    event JobCancelled(uint256 indexed jobId);
    event JobDisputed(uint256 indexed jobId, address indexed raisedBy, uint64 disputeDeadline);
    event DisputeResolved(uint256 indexed jobId, bool releasedToWorker);
    /// @dev Emitted so a second lender can see the first lender's claim, and
    ///      how much of the cash flow it consumes, before advancing against
    ///      the same collateral.
    event PayeeAssigned(uint256 indexed jobId, address indexed worker, address indexed payee, uint256 amount);
    /// @dev A worker missed its deadline; escrow returned to the requester.
    event JobReclaimed(uint256 indexed jobId, address indexed formerWorker);
    /// @dev A requester neither approved nor disputed in time.
    event ReviewExpired(uint256 indexed jobId);
    /// @dev The arbiter never ruled. Released to the worker — see expireDispute.
    event DisputeExpired(uint256 indexed jobId);

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
    error NoSuchJob();
    error BountyTooLow();
    error BadPayeeAmount();

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
        if (bounty < MIN_BOUNTY) revert BountyTooLow();
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
        // `Status.Open` is enum value ZERO, so every job that was never posted
        // reads back as Open. Without this check `acceptJob(999999)` succeeds
        // on a job that does not exist: it writes a worker, moves a phantom to
        // Accepted, and emits JobAccepted — an event the off-chain indexer and
        // the credit engine both take at face value. Nothing is stolen, because
        // the escrow is zero; a reputation record is minted from nothing, which
        // is what this system exists not to allow.
        //
        // One check is enough, and it goes exactly here: every other transition
        // requires a status a phantom cannot reach, or a msg.sender equal to a
        // requester that is address(0). `acceptJob` is the only door in.
        if (job.requester == address(0)) revert NoSuchJob();
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

    /// @notice Assign PART of this job's release to another address — a lender
    ///         that advanced the worker the capital to fund its own
    ///         subcontractors.
    /// @param  amount How much of the bounty the payee takes on release. The
    ///         remainder goes to the worker in the same transaction.
    /// @dev    Four properties, and they are the entire point:
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
    ///         claim and how much of the cash flow it consumes. Undisclosed
    ///         double-pledging of one asset is the oldest fraud in secured
    ///         lending.
    ///
    ///         PARTIAL — and this one is new, because assigning the WHOLE
    ///         bounty inverts the problem instead of solving it. A lender that
    ///         advances $40 against a $100 job and is named sole payee
    ///         receives $100 and owes the worker $60 back: off-chain,
    ///         unsecured, in the opposite direction. The worker has swapped
    ///         its own funding risk for counterparty risk on its lender, which
    ///         is not an improvement, it is a transfer. Assigning an amount
    ///         secures the lender for exactly what it advanced and leaves the
    ///         worker's margin where it already is.
    ///
    ///         `amount` is the loan-to-value ratio made real: it is the number
    ///         lib/orchestration-risk.ts computes, and the contract is where
    ///         it stops being an opinion.
    ///
    ///         ONE ASSIGNMENT ONLY, even though a partial one leaves a
    ///         remainder a second lender could in principle take. Two claims
    ///         on one uncertain cash flow need priority rules, and priority
    ///         rules are where secured lending gets genuinely hard. The event
    ///         discloses the first claim; a second lender can read it and
    ///         price the residual off-chain, or decline.
    ///
    ///         Note what this does NOT protect against: a refund. If the job
    ///         is reclaimed or the dispute goes against the worker, the escrow
    ///         returns to the requester and the lender is unsecured. That is
    ///         execution risk, it is exactly what the LTV in
    ///         lib/orchestration-risk.ts prices, and it is not the contract's
    ///         job to remove.
    function assignPayee(uint256 jobId, address payee, uint256 amount) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Accepted) revert WrongStatus();
        if (msg.sender != job.worker) revert NotWorker();
        if (payee == address(0)) revert ZeroPayee();
        if (job.payee != address(0)) revert PayeeAlreadySet();
        // Zero would be an assignment that secures nothing while consuming the
        // one slot; above the bounty would be a claim the escrow cannot honour,
        // and discovering that at release time is discovering it too late.
        if (amount == 0 || amount > job.bounty) revert BadPayeeAmount();

        job.payee = payee;
        job.payeeAmount = amount;
        emit PayeeAssigned(jobId, msg.sender, payee, amount);
    }

    /// @notice Requester disputes a submission instead of approving it.
    function raiseDispute(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Submitted) revert WrongStatus();
        if (msg.sender != job.requester) revert NotRequester();

        job.status = Status.Disputed;
        job.disputeDeadline = uint64(block.timestamp) + DISPUTE_WINDOW;
        emit JobDisputed(jobId, msg.sender, job.disputeDeadline);
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

    /// @notice The third stall, and the one the first draft of this contract
    ///         missed: a contested job whose arbiter never ruled.
    /// @dev    RESOLVES TO THE WORKER, and the direction is the whole design.
    ///
    ///         Only the requester can raise a dispute. If an unanswered
    ///         dispute refunded the requester, then `raiseDispute` would be a
    ///         free refund button with a two-week delay — strictly better for
    ///         a dishonest requester than waiting out `expireReview`, and it
    ///         would make every honest worker's escrow revocable at will. A
    ///         failed escalation must never pay the party that escalated, or
    ///         escalation stops being a claim and becomes a lever.
    ///
    ///         Read the other way round: the requester chose to make this
    ///         settlement depend on the arbiter. When that dependency does not
    ///         perform, the cost belongs to whoever chose it. The pre-dispute
    ///         state was "work delivered, awaiting judgement", and in the
    ///         absence of judgement the delivered work stands.
    ///
    ///         An honest requester is not exposed to this: they have fourteen
    ///         days in which the arbiter can rule, and the arbiter ruling is
    ///         the ordinary case. This is a backstop against an arbiter that
    ///         is gone — a lost key, a dead operator — not a schedule for one
    ///         that works.
    ///
    ///         Permissionless, for the same reason `reclaimJob` is: a recovery
    ///         path that needs a specific party makes that party an
    ///         availability risk, and here the missing party IS the arbiter.
    function expireDispute(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Disputed) revert WrongStatus();
        if (block.timestamp < job.disputeDeadline) revert TooEarly(uint64(block.timestamp), job.disputeDeadline);

        job.status = Status.Completed;
        _release(jobId, job);
        emit DisputeExpired(jobId);
    }

    /// @dev Single release path, so the payee assignment cannot be honoured on
    ///      one settlement route and forgotten on another. V1 released in two
    ///      places with duplicated logic; this is the same defect shape as the
    ///      off-chain money paths in docs/failure-modes.md.
    ///
    ///      Two recipients now, at most. `payeeAmount` is capped at the bounty
    ///      by `assignPayee`, so the subtraction cannot underflow and the two
    ///      transfers cannot exceed what this job escrowed — the invariant that
    ///      keeps one job's release from touching another job's money.
    function _release(uint256 jobId, Job storage job) private {
        uint256 toPayee = job.payee == address(0) ? 0 : job.payeeAmount;
        uint256 toWorker = job.bounty - toPayee;

        if (toPayee > 0) require(usdc.transfer(job.payee, toPayee), "release: payee transfer");
        // Skipped when a lender took the whole bounty — a zero transfer is a
        // real transfer that some tokens revert on, and it would strand the
        // settlement for no reason.
        if (toWorker > 0) require(usdc.transfer(job.worker, toWorker), "release: worker transfer");

        emit JobCompleted(jobId, job.worker, job.requester, job.bounty, job.payee, toPayee, toWorker);
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

    /// @notice Whether `expireDispute` would succeed right now — so the
    ///         off-chain sweep asks the contract instead of keeping a third
    ///         clock of its own.
    function disputeExpirable(uint256 jobId) external view returns (bool) {
        Job storage job = jobs[jobId];
        return job.status == Status.Disputed && block.timestamp >= job.disputeDeadline;
    }

    /// @notice What a release would pay out right now, split the way `_release`
    ///         would split it.
    /// @dev    For a lender deciding whether to advance: it should not have to
    ///         reimplement the split to learn what it is owed, and a lender
    ///         that reimplements it is a lender that can get it wrong.
    function releaseSplit(uint256 jobId) external view returns (address payee, uint256 toPayee, uint256 toWorker) {
        Job storage job = jobs[jobId];
        payee = job.payee;
        toPayee = payee == address(0) ? 0 : job.payeeAmount;
        toWorker = job.bounty - toPayee;
    }
}
