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
///            requires the arbiter — until DISPUTE_WINDOW passes, after which
///            `resolveDispute` and `expireDispute` are both open and it is
///            first-come-first-served between them. That is not a handover at a
///            fixed moment; it is a second door appearing beside the first.
contract LaborMarketV2 {
    IERC20 public immutable usdc;
    ICreditRegistry public immutable registry;
    address public immutable arbiter;

    /// @notice Protocol fee on posting, in basis points, and where it goes.
    /// @dev    Immutable, like everything else here. Set at deploy: 0 on a
    ///         testnet, non-zero on Base.
    ///
    ///         **This exists because the off-chain version only worked while
    ///         the operator held everyone's keys.** `lib/platform-fee.ts`
    ///         collects the posting fee as a separate USDC transfer that the
    ///         platform makes out of the requester's smart account. That is
    ///         enforceable exactly as long as the platform drives that
    ///         account — which is the custodial property v2 exists to remove.
    ///         An agent posting with its own key pays nothing, and the fee is
    ///         load-bearing: `docs/self-sybil-attack.md` prices manufacturing
    ///         a track record at the fee times the volume manufactured. A
    ///         deterrent that lapses the moment a user stops needing the
    ///         operator is not a deterrent, it is a courtesy.
    ///
    ///         Charged on POST and not refunded, because it is a toll rather
    ///         than a commission: it prices the act of occupying the board,
    ///         which is the act a wash-trading ring repeats. Charging it on
    ///         release instead would let a spammer post and cancel for free.
    ///         The cost is that an honest requester whose job nobody takes
    ///         pays for a job that never happened — a real cost, accepted
    ///         because a refundable toll is not a toll.
    uint16 public immutable feeBps;
    address public immutable feeRecipient;

    /// @dev Hard ceiling on what a deployment may charge, checked in the
    ///      constructor. Immutability means a fat-fingered fee is permanent,
    ///      so the bound is in the code rather than in the deploy script.
    uint16 public constant MAX_FEE_BPS = 500; // 5%

    /// @notice What a worker stakes to accept a job, in basis points of the
    ///         bounty. Slashed to the requester if the worker takes the job and
    ///         never delivers; returned in full on every other path.
    /// @dev    **Accepting used to be free, and the posting fee turned that into
    ///         a grief the VICTIM paid for.** A squatter accepted any
    ///         `minScore == 0` job and never delivered; `cancelJob` is Open-only
    ///         so the requester had no exit and waited out the whole delivery
    ///         window; `reclaimJob` then returned the bounty but NOT the fee,
    ///         and `Refunded` is terminal with no path back to `Open`, so
    ///         reposting cost the fee again. Measured over five cycles at a
    ///         1_000_000 bounty and 200bps: requester −100_000, house +100_000,
    ///         squatter's token balance byte-identical. At `feeBps = 0` the same
    ///         five cycles cost nothing, which isolates the cause exactly: the
    ///         fee converted a time-only grief into a money grief that scales
    ///         with the bounty while the attacker's cost stays one transaction
    ///         of gas.
    ///
    ///         The only on-chain defence before this was `minScore > 0`, which
    ///         by this product's own cold-start rule excludes every honest new
    ///         worker — so a requester had to choose between being griefed and
    ///         killing its own supply side, and an incumbent with a score could
    ///         squat every open job specifically to force that choice.
    ///
    ///         A bond is the answer rather than a fee refund because it makes
    ///         the squatter pay instead of merely making the victim whole, and
    ///         because `reclaimJob` is already a purely mechanical trigger — no
    ///         judgement, no new privileged party, nobody to appeal to.
    ///
    ///         What it costs, stated plainly: a worker now needs capital to
    ///         accept work. That is friction on the side of this market that is
    ///         harder to attract, and at `bondBps = 0` the whole mechanism is
    ///         off and behaviour is exactly as before — which is the right first
    ///         deployment while supply is scarce.
    uint16 public immutable bondBps;

    /// @dev Ceilings on the deployment-chosen numbers, checked in the
    ///      constructor. Every value below is immutable, so a fat-fingered
    ///      deploy argument is not a bug to fix but a contract to redeploy —
    ///      and by then the address is published and holding money. The bounds
    ///      live in the code for the same reason `MAX_FEE_BPS` does.
    uint16 public constant MAX_BOND_BPS = 2000; // 20% of the bounty
    uint16 public constant MAX_SILENCE_FORFEIT_BPS = 2000; // 20%
    /// @dev A floor on every window, because a zero-length one is a trap that
    ///      settles before anyone could act, and a ceiling because an unbounded
    ///      window is V1's frozen escrow wearing a number. The sum of the four
    ///      is the migration bound in docs/v2-plan.md, so the ceiling is also
    ///      what keeps that bound finite: 4 × 90 days.
    uint32 public constant MIN_WINDOW = 10 minutes;
    uint32 public constant MAX_WINDOW = 90 days;

    /// @notice Sum of every bounty this contract is still holding.
    /// @dev    Maintained so solvency is ONE call instead of a scan over
    ///         `jobCount` jobs. `usdc.balanceOf(address(this))` must always be
    ///         at least this; anyone can check it, which is the point.
    ///         "Publish the unflattering numbers" only works if the number is
    ///         cheap enough that it actually gets published.
    uint256 public totalEscrowed;

    /// @notice What each address may withdraw, and the sum of it.
    /// @dev    **Settlement CREDITS; it does not transfer.** See `withdraw`.
    ///         Held separately from `totalEscrowed` because they answer
    ///         different questions — one is money owed to unfinished jobs, the
    ///         other is money already earned and not yet collected — and a
    ///         solvency check that added them together without naming them
    ///         would hide which side a shortfall was on.
    mapping(address => uint256) public withdrawable;
    uint256 public totalWithdrawable;

    /// @dev `Expired` is appended, never inserted: the numeric values are what
    ///      every off-chain reader decodes, and renumbering an existing state
    ///      silently reinterprets history.
    enum Status {
        Open,
        Accepted,
        Submitted,
        Completed,
        Cancelled,
        Disputed,
        Refunded,
        /// @dev Settled by a deadline, with no verdict from anyone. Three
        ///      routes land here: the requester went silent (`expireReview`),
        ///      the arbiter never ruled (`expireDispute`), or nobody ever took
        ///      the job (`expireOpen`).
        ///
        ///      Its own state rather than `Refunded` for two reasons. On the
        ///      silence path the balances do not match a refund — the requester
        ///      gets back less than it escrowed — so a reconciler reading
        ///      `Refunded` would see a shortfall and have to decide whether it
        ///      was a bug or a theft. And nobody graded any of this work, so the
        ///      credit engine must not score it as a worker failure: unknown
        ///      verdict, do nothing.
        Expired
    }

    struct Job {
        address requester;
        address worker;
        uint256 bounty;
        uint256 minScore; // required worker credit score (0 = open to all)
        Status status;
        bytes32 specHash;
        bytes32 resultHash;
        /// @dev Absolute timestamp after which an unaccepted job can be
        ///      returned to its poster by anyone. Set at post time.
        uint64 openDeadline;
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
    uint32 public immutable MIN_DELIVERY_WINDOW;
    uint32 public immutable MAX_DELIVERY_WINDOW;

    /// @dev How long the requester has to approve or dispute after delivery.
    ///      Fixed rather than requester-chosen: it protects the WORKER, and a
    ///      value chosen by the party it constrains is not a protection.
    uint32 public immutable REVIEW_WINDOW;

    /// @dev How long a job may sit `Open` before anyone can return it to its
    ///      poster.
    ///
    ///      **`Open` was the fourth stall, and it is the state every job starts
    ///      in.** `cancelJob` is requester-only, so a posted job that nobody
    ///      accepted and whose requester lost its key held escrow forever, with
    ///      no deadline and no permissionless exit — R1 exactly, in the state
    ///      nobody thought to look at because it is where jobs are *supposed*
    ///      to wait. Measured at ten simulated years: reclaimJob, expireReview
    ///      and expireDispute all `WrongStatus()`, cancelJob `NotRequester()`,
    ///      escrow intact.
    ///
    ///      It also falsified this contract's own migration story. "Deploy v3,
    ///      stop posting to v2, wait" terminates only if every job dies of old
    ///      age; a job that is never accepted never enters the
    ///      delivery/review/dispute chain at all.
    ///
    ///      Long, deliberately. A job waiting for the right worker is doing its
    ///      job, and a short window would force honest requesters to repost.
    ///      Nobody has to wait for it — the requester may cancel at any moment.
    ///      This is only a backstop for a requester who is gone.
    uint32 public immutable MAX_OPEN_WINDOW;

    /// @dev How long the arbiter has to rule on a contested job. Longer than
    ///      the review window because this is the one window a human is meant
    ///      to spend reading a deliverable and an objection. It is a backstop
    ///      against an arbiter that is gone, not a schedule for one that works.
    uint32 public immutable DISPUTE_WINDOW;

    /// @dev A bounty of zero escrows nothing, and a job that escrows nothing
    ///      still emits JobAccepted and JobCompleted — which is the raw
    ///      material the credit engine scores. Free completions are free
    ///      reputation, so the floor is one unit of the token rather than
    ///      zero. Deliberately ONE UNIT and not a dollar: the mainnet plan
    ///      turns on cent-scale bounties, and a floor that prices out the
    ///      product is a worse bug than the one it prevents.
    uint256 public immutable MIN_BOUNTY;

    /// @dev What a requester forfeits to the worker by neither approving nor
    ///      disputing. 10%, in basis points.
    ///
    ///      Without it, silence is FREE AND DOMINANT for a dishonest
    ///      requester: the deliverable arrived off-chain the moment it was
    ///      submitted, approving costs gas, disputing costs gas, and doing
    ///      nothing returns the whole bounty seven days later. An earlier draft
    ///      answered that the market prices absent requesters out — but that is
    ///      off-chain reputation, which is the thing docs/product-thesis.md
    ///      argues does not carry. A defence that depends on the weakest claim
    ///      in the product is not a defence.
    ///
    ///      The forfeit lands on requester INATTENTION specifically. A
    ///      requester who reads their deliverables and disputes the bad ones
    ///      never pays it; there is no honest behaviour it taxes.
    ///
    ///      What it costs, stated plainly: a worker who submits garbage now
    ///      earns 10% whenever it finds an inattentive requester. That is a
    ///      real hole and it is bounded — one dispute closes it, the worker
    ///      still burns a delivery window and a job slot per attempt, and every
    ///      requester who does respond records a graded failure against it.
    ///      Accepted deliberately: the failure it prevents is a free option on
    ///      every job in the market, and the failure it creates is capped at a
    ///      tenth of one bounty per inattentive counterparty.
    uint16 public immutable SILENCE_FORFEIT_BPS;

    /// @dev Gas allowed to the credit registry per lookup. Generous for a
    ///      mapping read, far too little to grief with. See `_scoreOf`.
    uint256 public constant REGISTRY_GAS_LIMIT = 100_000;

    uint256 public jobCount;
    mapping(uint256 => Job) public jobs;

    event JobPosted(
        uint256 indexed jobId,
        address indexed requester,
        uint256 bounty,
        uint256 minScore,
        bytes32 specHash,
        uint32 deliveryWindow,
        /// @dev What the requester paid on top. Reported so the fee is
        ///      auditable from the log rather than inferred from a constant
        ///      the reader has to go and look up.
        uint256 fee
    );
    // NOTE: `openDeadline` is deliberately NOT a parameter here. Adding an
    // eighth made the function stack-too-deep, and the value is derivable by
    // any reader that has the log: it is this event's own block timestamp plus
    // the public `MAX_OPEN_WINDOW`. It is also on the job itself, and
    // `openExpirable(jobId)` answers the question directly.
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
    /// @dev Nobody ever accepted it; escrow returned to the requester.
    event OpenExpired(uint256 indexed jobId);
    /// @dev A requester neither approved nor disputed in time. Carries every
    ///      leg, because this is the one terminal state where the escrow goes
    ///      to more than one place and a reader that assumes "refund" would be
    ///      wrong about all of them.
    event ReviewExpired(uint256 indexed jobId, uint256 refunded, uint256 toPayee, uint256 toWorker);
    /// @dev The arbiter never ruled. Released to the worker side — see
    ///      expireDispute. Split reported for the same reason as JobCompleted.
    event DisputeExpired(uint256 indexed jobId, uint256 toPayee, uint256 toWorker);
    /// @dev Money actually leaving. Every other event above describes a CREDIT;
    ///      this is the only one that means a token moved, and an indexer that
    ///      conflates the two will report a worker as paid before it has been.
    event Withdrawn(address indexed account, address indexed to, uint256 amount);
    /// @dev Every movement of escrow into a withdrawable balance, with the
    ///      creditor named and the amount stated. The per-status events say
    ///      what HAPPENED to a job; this says who is owed what, which is the
    ///      only question an indexer or a lender is actually asking.
    event Credited(uint256 indexed jobId, address indexed to, uint256 amount);

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
    error FeeTooHigh();
    error ZeroFeeRecipient();
    error NothingToWithdraw();
    error RegistryUnavailable();
    error TooLate(uint64 nowTs, uint64 deadline);
    error NotAContract(address addr);
    error TransferFailed();
    error BondTooHigh();
    error ForfeitTooHigh();

    /// @notice Every number a deployment gets to choose.
    /// @dev    A STRUCT and not eleven positional arguments, deliberately. These
    ///         are all immutable: a transposed pair at deploy time is not a bug
    ///         to fix, it is a redeployment, and by the time anyone notices the
    ///         address is published and holding money. `reviewWindow` and
    ///         `disputeWindow` are both `uint32` seconds, so swapping them
    ///         compiles, deploys, and passes every bounds check. Named fields at
    ///         the call site are the only thing that actually prevents that.
    ///
    ///         They were `constant` until now, which meant one source tree could
    ///         not serve both a testnet and Base: seven days of review is very
    ///         long for a market whose jobs finish in minutes, and it is the
    ///         exposure window for both the accept-squat and the silence
    ///         forfeit. Making them constructor arguments costs nothing against
    ///         the no-owner property — there is still no setter for any of them.
    struct Config {
        uint16 feeBps;
        address feeRecipient;
        uint16 bondBps;
        uint32 minDeliveryWindow;
        uint32 maxDeliveryWindow;
        uint32 reviewWindow;
        uint32 maxOpenWindow;
        uint32 disputeWindow;
        uint16 silenceForfeitBps;
        uint256 minBounty;
    }

    constructor(address _usdc, address _registry, address _arbiter, Config memory cfg) {
        if (cfg.feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        // A non-zero fee with nowhere to send it would burn every posting fee
        // to address(0), permanently, with no way to notice until someone
        // reconciled revenue that never arrived.
        if (cfg.feeBps > 0 && cfg.feeRecipient == address(0)) revert ZeroFeeRecipient();
        if (cfg.bondBps > MAX_BOND_BPS) revert BondTooHigh();
        if (cfg.silenceForfeitBps > MAX_SILENCE_FORFEIT_BPS) revert ForfeitTooHigh();
        // Each window inside the global bounds, and the delivery pair ordered.
        // A max below the min would make `postJob` reject EVERY window and the
        // market would accept no work at all — deployable, and dead.
        if (!_windowOk(cfg.minDeliveryWindow) || !_windowOk(cfg.maxDeliveryWindow)) revert BadWindow();
        if (cfg.minDeliveryWindow > cfg.maxDeliveryWindow) revert BadWindow();
        if (!_windowOk(cfg.reviewWindow) || !_windowOk(cfg.maxOpenWindow) || !_windowOk(cfg.disputeWindow)) {
            revert BadWindow();
        }
        // Zero would make free completions possible again, which is the raw
        // material the credit engine scores. See MIN_BOUNTY.
        if (cfg.minBounty == 0) revert BountyTooLow();
        // Every address here is immutable, so a wrong one is not a bug to fix,
        // it is a contract to redeploy. A token or registry that is an EOA or
        // an empty address does not revert at deploy time — it deploys fine and
        // then reverts on the first transferFrom, i.e. once real money is
        // involved and the address is already published.
        if (_usdc.code.length == 0) revert NotAContract(_usdc);
        if (_registry.code.length == 0) revert NotAContract(_registry);
        // The arbiter may be an EOA, so only the zero check applies: at zero
        // no one could ever call resolveDispute, and every contested job would
        // wait out DISPUTE_WINDOW for a ruling that cannot arrive.
        if (_arbiter == address(0)) revert ZeroPayee();
        usdc = IERC20(_usdc);
        registry = ICreditRegistry(_registry);
        arbiter = _arbiter;
        feeBps = cfg.feeBps;
        feeRecipient = cfg.feeRecipient;
        bondBps = cfg.bondBps;
        MIN_DELIVERY_WINDOW = cfg.minDeliveryWindow;
        MAX_DELIVERY_WINDOW = cfg.maxDeliveryWindow;
        REVIEW_WINDOW = cfg.reviewWindow;
        MAX_OPEN_WINDOW = cfg.maxOpenWindow;
        DISPUTE_WINDOW = cfg.disputeWindow;
        SILENCE_FORFEIT_BPS = cfg.silenceForfeitBps;
        MIN_BOUNTY = cfg.minBounty;
    }

    function _windowOk(uint32 w) private pure returns (bool) {
        return w >= MIN_WINDOW && w <= MAX_WINDOW;
    }

    /// @notice Post a job, escrowing `bounty` USDC.
    /// @dev    **Approve `postCost(bounty)`, not `bounty`.** The fee is charged
    ///         ON TOP, so this pulls `bounty + fee` and an allowance of exactly
    ///         the bounty reverts every time. An earlier version of this
    ///         sentence said `bounty`, which on a deployment with a non-zero
    ///         fee is an instruction that fails on the first attempt and every
    ///         attempt after it — and the contract cannot be upgraded, so a
    ///         wrong instruction in its own NatSpec is permanent. Batch the
    ///         approve into the same UserOp.
    /// @param deliveryWindow How long the accepting worker gets to deliver.
    function postJob(uint256 bounty, uint256 minScore, bytes32 specHash, uint32 deliveryWindow)
        external
        returns (uint256 jobId)
    {
        if (deliveryWindow < MIN_DELIVERY_WINDOW || deliveryWindow > MAX_DELIVERY_WINDOW) revert BadWindow();
        if (bounty < MIN_BOUNTY) revert BountyTooLow();

        // The requester pays bounty + fee; the WORKER still gets the whole
        // advertised bounty. Taking the fee out of the bounty instead would
        // mean the number on the board is not the number that arrives, and a
        // market where the posted price is not the paid price is a market
        // nobody can price against.
        uint256 fee = (bounty * feeBps) / 10_000;
        _safeTransferFrom(msg.sender, bounty + fee);
        // The fee is CREDITED, not sent. Sending it here put a third party's
        // ability to receive on the critical path of every posting: one
        // blocklisted fee recipient and the market accepts no work at all.
        if (fee > 0) {
            withdrawable[feeRecipient] += fee;
            totalWithdrawable += fee;
        }

        totalEscrowed += bounty;
        jobId = ++jobCount;
        Job storage job = jobs[jobId];
        job.requester = msg.sender;
        job.bounty = bounty;
        job.minScore = minScore;
        job.status = Status.Open;
        job.specHash = specHash;
        job.deliveryWindow = deliveryWindow;
        job.openDeadline = uint64(block.timestamp) + MAX_OPEN_WINDOW;
        emit JobPosted(jobId, msg.sender, bounty, minScore, specHash, deliveryWindow, fee);
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
        // `acceptJob` and `expireOpen` are the two doors reachable on a phantom,
        // because both accept `Open` and `Open` is what an unwritten slot
        // decodes to. Both check. Every other transition requires a status a
        // phantom cannot reach, or a msg.sender equal to a requester that is
        // address(0).
        if (job.requester == address(0)) revert NoSuchJob();
        if (job.status != Status.Open) revert WrongStatus();
        // `expireOpen` did not CLOSE `Open`; it only added a door out of it. So
        // without this, a job stays acceptable at day 61 — and taking it slams
        // that door, and the requester's own `cancelJob` with it. A stranger who
        // never intends to work then submits a junk hash and collects
        // SILENCE_FORFEIT_BPS from a requester who is absent BY CONSTRUCTION:
        // `openExpirable` is a free public view naming exactly the requesters
        // for whom both stated mitigations of the forfeit are void. It converts
        // a designed 100% recovery into 90% arriving up to 37 days later, for
        // the price of gas — `acceptJob` takes no bond, so nothing is at stake.
        //
        // This was the only place an unrelated third party could pre-empt a
        // permissionless exit. `reclaimJob` can only be pre-empted by the
        // worker, `expireReview` by the requester, `expireDispute` by the
        // arbiter — in each case by the deadline's own principal, which is the
        // difference between a party acting late and a party being replaced.
        //
        // It cannot strand anything: past `openDeadline` both `expireOpen` and
        // `cancelJob` remain callable on an Open job.
        if (block.timestamp >= job.openDeadline) revert TooLate(uint64(block.timestamp), job.openDeadline);
        if (msg.sender == job.requester) revert SelfWork();

        uint256 score = _scoreOf(msg.sender, job.minScore);
        if (score < job.minScore) revert ScoreTooLow(score, job.minScore);

        job.worker = msg.sender;
        job.status = Status.Accepted;
        job.deliveryDeadline = uint64(block.timestamp) + job.deliveryWindow;

        // Status is written BEFORE the token call, so a reentrant token that
        // calls back into acceptJob finds a job that is no longer Open.
        uint256 bond = bondFor(job.bounty);
        if (bond > 0) {
            totalEscrowed += bond;
            _safeTransferFrom(msg.sender, bond);
        }
        emit JobAccepted(jobId, msg.sender, score, job.deliveryDeadline);
    }

    /// @notice What a worker must stake to accept a job of this bounty, and
    ///         therefore what it must approve to this contract first.
    /// @dev    Derived from the bounty rather than stored, so there is no new
    ///         struct field, no index shift for positional readers, and no
    ///         possibility of a stored bond disagreeing with the rate that was
    ///         charged. `bondBps` is immutable, so this answer never changes for
    ///         a given bounty.
    function bondFor(uint256 bounty) public view returns (uint256) {
        return (bounty * bondBps) / 10_000;
    }

    /// @dev Read a worker's score without letting the registry take the market
    ///      down with it.
    ///
    ///      `registry` is immutable and was called bare. An unguarded external
    ///      call to an address that can never be changed means that if the
    ///      registry is ever upgraded into something that reverts, or simply
    ///      stops answering, **no job can be accepted again, ever** — the
    ///      market stops taking work while the contract still holds escrow.
    ///      (Not frozen: `cancelJob` still refunds Open jobs, so requesters can
    ///      leave. It stops, it does not steal. Pinned by a test.)
    ///
    ///      Unknown score is treated as ZERO, which resolves the two cases in
    ///      opposite and correct directions:
    ///
    ///        minScore == 0  the gate was never going to reject anyone, so an
    ///                       unreadable score changes nothing and the job
    ///                       proceeds. The market keeps working.
    ///        minScore > 0   the requester asked for a guarantee that cannot be
    ///                       checked. Refuse. "Never act on missing evidence"
    ///                       (docs/failure-modes.md invariant 5) — and the
    ///                       caller gets `RegistryUnavailable`, not a
    ///                       `ScoreTooLow(0, n)` that would blame the worker
    ///                       for the registry being down.
    ///
    ///      The gas stipend is a separate hazard: a registry that consumed
    ///      everything would leave the 1/64 remainder, too little to finish, so
    ///      the catch would not save the transaction. 100k is far above any
    ///      honest score lookup and far below a griefing budget.
    function _scoreOf(address worker, uint256 minScore) private view returns (uint256) {
        try registry.creditScore{gas: REGISTRY_GAS_LIMIT}(worker) returns (uint256 score) {
            return score;
        } catch {
            if (minScore > 0) revert RegistryUnavailable();
            return 0;
        }
    }

    /// @notice Worker submits the deliverable (referenced off-chain by hash).
    /// @dev    A submission that lands in the same block as a reclaim cannot
    ///         double-settle: whichever transaction is mined first moves the
    ///         status, and the second reverts with WrongStatus.
    ///
    ///         **Past the deadline the worker loses the right to deliver**, and
    ///         that is a stronger answer to the mech#470 race than block order.
    ///         Without it the deadline meant only "the moment somebody else MAY
    ///         reclaim", so a worker who blew it by a month could still submit
    ///         first and win: the job would move to `Submitted`, restarting a
    ///         seven-day review clock, and the requester would have to actively
    ///         dispute or forfeit a tenth to a worker who had already failed.
    ///         The requester would be defending against a deadline that had
    ///         already passed in its favour.
    ///
    ///         So the race now has one answer instead of two. Before the
    ///         deadline only `submitWork` can win; after it, only `reclaimJob`
    ///         can. A worker one second late loses the claim — which is what a
    ///         deadline is, and MIN_DELIVERY_WINDOW keeps the windows from
    ///         being hair-trigger.
    function submitWork(uint256 jobId, bytes32 resultHash) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Accepted) revert WrongStatus();
        if (msg.sender != job.worker) revert NotWorker();
        if (block.timestamp >= job.deliveryDeadline) revert TooLate(uint64(block.timestamp), job.deliveryDeadline);
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
    ///
    ///         What IS the contract's job is not lying about the odds. Risk the
    ///         lender prices and certainty it cannot see are different things,
    ///         and the deadline check below is the line between them — see the
    ///         comment on it.
    function assignPayee(uint256 jobId, address payee, uint256 amount) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Accepted) revert WrongStatus();
        if (msg.sender != job.worker) revert NotWorker();
        // `Accepted` past `deliveryDeadline` is not a late job, it is a DEAD
        // one: `submitWork` reverts TooLate, and the single remaining
        // transition is `reclaimJob` — 100% to the requester. `deliveryDeadline`
        // is written once, in `acceptJob`, and never rewritten, so this is a
        // certainty and not a race.
        //
        // Before `submitWork` got its own TooLate guard this was merely
        // unlikely; the guard is what made it provable, which is the kind of
        // thing that only shows up when you compose two fixes. Without this
        // check the contract lets a lender perfect a claim on escrow that is
        // already unreachable by every release path at the moment it advances,
        // and `releaseSplit` — the one function a lender is told to trust —
        // then quotes it a positive number. A sybil requester/worker pair nets
        // the advance for the price of a posting fee.
        if (block.timestamp >= job.deliveryDeadline) revert TooLate(uint64(block.timestamp), job.deliveryDeadline);
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
            _credit(jobId, job.requester, job.bounty);
            // Amount 0: the requester takes the whole bounty, and the worker
            // gets its bond back. Losing a dispute means the work was judged
            // bad, not that it never arrived — the bond answers only the second.
            // Confiscating it here would punish delivering badly with the
            // instrument built to punish not delivering at all.
            _payWorkerSide(jobId, job, 0);
        }
        emit DisputeResolved(jobId, releaseToWorker);
    }

    /// @notice Requester cancels an unaccepted job and reclaims the escrow.
    function cancelJob(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Open) revert WrongStatus();
        if (msg.sender != job.requester) revert NotRequester();

        job.status = Status.Cancelled;
        _credit(jobId, job.requester, job.bounty);
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
        // Bounty back, and the squatter's bond ON TOP. The only path in this
        // contract that moves the bond to anyone but the worker, and the only
        // one where the worker held a job through its entire delivery window and
        // delivered nothing. No judgement is involved: the trigger is a deadline
        // that has passed with an empty `resultHash`, which is why this needed no
        // new privileged party and nobody to appeal to.
        _credit(jobId, job.requester, job.bounty + bondFor(job.bounty));
        emit JobReclaimed(jobId, formerWorker);
    }

    /// @notice The fourth stall: a job nobody ever took.
    /// @dev    Permissionless once `MAX_OPEN_WINDOW` has passed, for the same
    ///         reason as every other exit here — a recovery path that requires
    ///         a specific party makes that party an availability risk, and the
    ///         missing party in this one is the requester itself.
    ///
    ///         Settles to `Expired`, not `Refunded`. No worker was ever
    ///         involved, so there is nothing for the credit engine to score,
    ///         and `Refunded` is the state that means a worker was judged or
    ///         failed to deliver.
    function expireOpen(uint256 jobId) external {
        Job storage job = jobs[jobId];
        // The same phantom `acceptJob` guards against, reached through the other
        // door this function opened. An unwritten slot is `Open` (enum 0) with
        // `openDeadline` 0, so BOTH guards below pass on a job nobody posted.
        // No money moves — `_credit` early-returns on zero — but anyone can mint
        // terminal-state records at arbitrary ids for the price of gas, in a
        // product whose entire claim is a credit score derived from on-chain
        // behaviour. The off-chain `onchainJobId` is a bare integer with no
        // contract address beside it, so an indexer has no discriminator.
        if (job.requester == address(0)) revert NoSuchJob();
        if (job.status != Status.Open) revert WrongStatus();
        if (block.timestamp < job.openDeadline) revert TooEarly(uint64(block.timestamp), job.openDeadline);

        job.status = Status.Expired;
        _credit(jobId, job.requester, job.bounty);
        emit OpenExpired(jobId);
    }

    /// @notice Whether `expireOpen` would succeed right now.
    function openExpirable(uint256 jobId) external view returns (bool) {
        Job storage job = jobs[jobId];
        return job.requester != address(0) && job.status == Status.Open
            && block.timestamp >= job.openDeadline;
    }

    /// @notice The mirror stall: work was delivered and the requester never
    ///         approved and never disputed. Also permissionless once the
    ///         review window has passed.
    /// @dev    Resolves MOSTLY to a refund: the requester gets its bounty back
    ///         minus SILENCE_FORFEIT_BPS, which goes to the worker side.
    ///
    ///         Neither extreme is right. Paying the full bounty out on silence
    ///         would make "submit anything and wait" a way to extract escrow
    ///         with no grader ever passing the work, which is the one thing
    ///         this system exists to prevent. Refunding all of it makes
    ///         silence free — and free is not neutral, it is dominant. The
    ///         requester already holds the deliverable; it arrived off-chain
    ///         the moment it was submitted. Approving costs gas, disputing
    ///         costs gas, and saying nothing pays.
    ///
    ///         So the requester pays a tenth for the option it took. It is not
    ///         a payment for the work — nobody judged the work, and this
    ///         contract never decides that. It is the price of leaving the
    ///         question unanswered, charged to the only party who could have
    ///         answered it.
    ///
    ///         Rounds DOWN, so a bounty small enough that a tenth is zero
    ///         forfeits nothing rather than reverting. At cent scale that is
    ///         the correct direction to be wrong in: a settlement that cannot
    ///         execute is worse than a forfeit that does not apply.
    function expireReview(uint256 jobId) external {
        Job storage job = jobs[jobId];
        if (job.status != Status.Submitted) revert WrongStatus();
        if (block.timestamp < job.reviewDeadline) revert TooEarly(uint64(block.timestamp), job.reviewDeadline);

        uint256 forfeit = (job.bounty * SILENCE_FORFEIT_BPS) / 10_000;
        uint256 refund = job.bounty - forfeit;

        job.status = Status.Expired;
        (uint256 toPayee, uint256 toWorker) = _payWorkerSide(jobId, job, forfeit);
        _credit(jobId, job.requester, refund);
        emit ReviewExpired(jobId, refund, toPayee, toWorker);
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

        // `Expired`, not `Completed`, and the distinction is the same one
        // `expireReview` makes: NOBODY JUDGED THIS WORK. The arbiter vanished.
        // Marking it Completed would tell the credit engine a grader passed
        // it, and a scoring system that cannot tell "approved" from "nobody
        // showed up" is buying reputation with an absence.
        //
        // The taxonomy the three terminal states carry:
        //   Completed — someone decided the work was good
        //   Refunded  — someone decided it was not, or it never arrived
        //   Expired   — settled by a deadline; no verdict exists
        job.status = Status.Expired;
        (uint256 toPayee, uint256 toWorker) = _payWorkerSide(jobId, job, job.bounty);
        emit DisputeExpired(jobId, toPayee, toWorker);
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
    /// @dev Settlement, in one place: move `amount` out of this job's escrow
    ///      and into `to`'s withdrawable balance.
    ///
    ///      **No token transfer happens here, and that is the point.** See the
    ///      note on `withdraw` for why pushing was a frozen escrow waiting for
    ///      Circle to press a button.
    ///
    ///      `totalEscrowed` is a claim about solvency, and a settlement route
    ///      that forgets to decrement it makes the contract look permanently
    ///      over-collateralised — the direction that hides a real shortfall
    ///      behind an accounting one. Every settlement goes through here.
    ///
    ///      Emits `Credited`, and that is not decoration. Five of the eight
    ///      credit-producing events omit either the address or the amount:
    ///      `JobCancelled` and `OpenExpired` carry neither, `JobReclaimed` names
    ///      the former WORKER while crediting the requester, `DisputeResolved`
    ///      carries only a bool, and `ReviewExpired`/`DisputeExpired` carry
    ///      amounts but no addresses. Everything is reconstructible by joining
    ///      four event types on jobId and replaying `_payWorkerSide`'s min()
    ///      waterfall off-chain — which is precisely the mistake `releaseSplit`
    ///      exists to spare lenders, reintroduced one layer down. And nothing
    ///      lets an indexer DISCOVER a creditor: `withdrawable(address)` needs
    ///      an address you already have.
    function _credit(uint256 jobId, address to, uint256 amount) private {
        if (amount == 0) return;
        totalEscrowed -= amount;
        withdrawable[to] += amount;
        totalWithdrawable += amount;
        emit Credited(jobId, to, amount);
    }

    function _release(uint256 jobId, Job storage job) private {
        (uint256 toPayee, uint256 toWorker) = _payWorkerSide(jobId, job, job.bounty);
        emit JobCompleted(jobId, job.worker, job.requester, job.bounty, job.payee, toPayee, toWorker);
    }

    /// @dev Pay `amount` of this job's escrow to the worker side, LENDER FIRST.
    ///
    ///      A strict waterfall rather than a proportional split, and the
    ///      difference only shows up on the forfeit path — where the amount is
    ///      a tenth of the bounty and may be less than what the lender
    ///      advanced. Paying the borrower ahead of its own secured lender out
    ///      of the same collateral is the exact thing a lien exists to prevent,
    ///      and it would mean a THIRD PARTY's inaction (the requester's) could
    ///      strip a lender's security. The assignment is irrevocable; a
    ///      requester going quiet must not be able to revoke it by proxy.
    ///
    ///      `amount` is always <= bounty and `payeeAmount` is capped at bounty
    ///      by assignPayee, so neither subtraction can underflow and the two
    ///      transfers can never exceed what this job escrowed.
    function _payWorkerSide(uint256 jobId, Job storage job, uint256 amount)
        private
        returns (uint256 toPayee, uint256 toWorker)
    {
        if (job.payee != address(0)) {
            toPayee = amount < job.payeeAmount ? amount : job.payeeAmount;
        }
        toWorker = amount - toPayee;

        // The bond comes back HERE, in the single release path, for exactly the
        // reason the payee split is here: a return that lived at each call site
        // would be honoured on some routes and forgotten on others, which is the
        // defect shape this function was extracted to prevent. Every transition
        // out of `Submitted` or `Disputed` reaches this line — including
        // `resolveDispute(false)`, which calls it with amount 0 precisely so the
        // worker's own stake is not confiscated for losing an argument about
        // quality. `reclaimJob` is the ONLY path that does not come through
        // here, and it is the only path where the worker never delivered.
        //
        // Credited as its own leg rather than folded into `toWorker`, so the
        // per-status events keep meaning "how the BOUNTY was split" and the
        // `Credited` legs stay literally true about what each address received.
        uint256 bond = bondFor(job.bounty);

        // Both legs are guarded inside _payOut: a zero transfer is a real
        // transfer that some tokens revert on, and stranding a settlement over
        // a zero-value leg would be the whole failure class this contract
        // exists to close.
        _credit(jobId, job.payee, toPayee);
        _credit(jobId, job.worker, toWorker);
        // Never to the payee: the bond is the worker's own capital, so a lien on
        // the bounty has no claim on it.
        _credit(jobId, job.worker, bond);
    }

    /// @notice Collect everything settlement has credited to you.
    /// @dev    **This is why settlement never transfers.**
    ///
    ///         Every payout used to be a push inside the settling transaction,
    ///         and `require(usdc.transfer(...))` meant one recipient's inability
    ///         to receive reverted the whole settlement. Base USDC is
    ///         upgradeable by Circle and enforces a blocklist, so "inability to
    ///         receive" is not hypothetical and is not chosen by anyone in the
    ///         market. Measured against a blocklisting token
    ///         (tests/labor-market-v2-hostile.evm.test.ts), the old design gave:
    ///
    ///           blocked worker    -> approveJob, resolveDispute(true) and
    ///                                expireDispute all revert; escrow frozen
    ///           blocked requester -> cancelJob, reclaimJob and expireReview
    ///                                revert, taking the WORKER's forfeit with
    ///                                them
    ///           blocked payee     -> every settlement route reverts
    ///           blocked feeRecip. -> every postJob reverts; the market stops
    ///
    ///         That is residual risk R1 — a frozen escrow with no exit —
    ///         reintroduced through the token after the state machine had been
    ///         carefully built to make it impossible. Three permissionless
    ///         timeouts do not help if the timeout itself cannot execute.
    ///
    ///         Crediting instead means a blocked address blocks only ITSELF:
    ///         the job settles, everyone else is paid, and the blocked party's
    ///         balance waits. It can still be recovered — see `withdrawTo`.
    ///
    ///         What this costs, plainly: money no longer lands in a wallet as
    ///         part of the job finishing. Every party takes one extra
    ///         transaction to collect. For the smart accounts this market runs
    ///         on, that batches — one withdraw after fifty jobs is cheaper in
    ///         total gas than fifty transfers — but it IS a second step, and
    ///         any UI that said "paid" now has to say "claimable".
    function withdraw() external returns (uint256 amount) {
        return _withdrawTo(msg.sender);
    }

    /// @notice Collect your balance to a different address.
    /// @dev    The escape hatch for the party the token itself has frozen. USDC
    ///         checks the sender and the recipient of a transfer; the sender
    ///         here is this contract, so a blocked address that names an
    ///         unblocked one is paid. Without this, crediting would merely move
    ///         the trap from the job to the balance.
    ///
    ///         Only ever your OWN balance, to an address you choose. There is
    ///         no path for anyone to move anyone else's.
    function withdrawTo(address to) external returns (uint256 amount) {
        if (to == address(0)) revert ZeroPayee();
        // The other address that destroys the money. Paying this contract puts
        // the tokens back where they came from as surplus nobody can sweep,
        // while the caller's balance is already zeroed — the whole credit, gone,
        // with the accounting perfectly consistent about it. Self-inflicted, so
        // it is not an attack; but this function exists to be called
        // PROGRAMMATICALLY by smart accounts passing an address, and the guard
        // is one comparison.
        if (to == address(this)) revert ZeroPayee();
        return _withdrawTo(to);
    }

    function _withdrawTo(address to) private returns (uint256 amount) {
        amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        // Zeroed before the transfer. The token is trusted and not reentrant,
        // but checks-effects-interactions costs nothing here and the one thing
        // this contract must never do is pay the same balance twice.
        withdrawable[msg.sender] = 0;
        totalWithdrawable -= amount;
        _safeTransfer(to, amount);
        emit Withdrawn(msg.sender, to, amount);
    }

    /// @dev The one token-upgrade scenario the pull-payment rewrite does not
    ///      otherwise survive.
    ///
    ///      `require(usdc.transfer(...))` asks Solidity to ABI-decode a bool
    ///      from the return data. USDC on Base is a proxy Circle can upgrade,
    ///      and if an upgrade ever made `transfer` return NOTHING — the shape
    ///      USDT has always had on Ethereum — that decode reverts and EVERY
    ///      withdrawal in this contract is bricked. Permanently: there is no
    ///      owner, no sweep, no rescue, by design. The design that makes the
    ///      contract trustworthy is the same one that makes this unfixable.
    ///
    ///      So accept both conventions: success is "the call did not revert AND
    ///      (it returned nothing OR it returned true)". A token that reverts on
    ///      failure still reverts; a token that returns false still fails here.
    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    /// @dev The inbound twin of `_safeTransfer`, for the same reason. Pulls into
    ///      this contract only — there is no caller-supplied destination, so it
    ///      cannot be turned into a way to move a third party's approval
    ///      somewhere else.
    function _safeTransferFrom(address from, uint256 amount) private {
        (bool ok, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount)
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    /// @notice Exactly what `postJob(bounty, ...)` will pull from the caller.
    /// @dev    So a requester never recomputes the fee. Same reasoning as
    ///         `releaseSplit` — a lender that reimplements the split is a
    ///         lender that can get it wrong, and a requester that reimplements
    ///         the fee is a requester whose posting reverts.
    function postCost(uint256 bounty) public view returns (uint256) {
        return bounty + (bounty * feeBps) / 10_000;
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
    ///         **Status-aware, and it has to be.** A settled job still has a
    ///         `payee` and a `payeeAmount` in storage; reporting them would
    ///         tell a lender it has a live claim on money that was paid out
    ///         days ago. The whole reason this function exists is that a lender
    ///         should not have to reconstruct the answer — so an answer that is
    ///         confidently wrong is worse than no function at all. Zeros here
    ///         mean "this route can no longer pay you"; `withdrawable` is where
    ///         an already-settled claim now lives.
    function releaseSplit(uint256 jobId) external view returns (address payee, uint256 toPayee, uint256 toWorker) {
        Job storage job = jobs[jobId];
        // Only these states can still reach _release — and status alone is not
        // enough to say so. Open past `openDeadline`, Submitted past
        // `reviewDeadline` and Disputed past `disputeDeadline` can all still
        // release; `Accepted` past `deliveryDeadline` cannot, because
        // `submitWork` is closed and `reclaimJob` pays the requester 100%. That
        // one asymmetry is the whole reason for the second check.
        if (job.status != Status.Open && job.status != Status.Accepted && job.status != Status.Submitted
            && job.status != Status.Disputed) {
            return (address(0), 0, 0);
        }
        if (job.status == Status.Accepted && block.timestamp >= job.deliveryDeadline) {
            return (address(0), 0, 0);
        }
        payee = job.payee;
        toPayee = payee == address(0) ? 0 : job.payeeAmount;
        toWorker = job.bounty - toPayee;
    }

    /// @notice Does this contract hold what it says it owes?
    /// @return owed     the sum of every unsettled bounty
    /// @return held     the contract's actual token balance
    /// @return surplus  held - owed, floored at zero
    /// @dev    ONE call, and that is the whole design goal: a solvency check
    ///         costing a scan over every job ever posted is a check nobody
    ///         runs, and an invariant nobody runs is not an invariant.
    ///
    ///         `held` should sit slightly above `owed` forever. Tokens sent
    ///         here by mistake land in the surplus and stay. There is
    ///         deliberately NO sweep: a function that moves tokens the contract
    ///         does not owe is a function that can move tokens it does, and
    ///         "nobody has that button" is this contract's one real security
    ///         property.
    ///
    ///         **`held < owed` is the alarm.** No path here can produce it, so
    ///         if it ever reads that way the token is not behaving like USDC —
    ///         fee-on-transfer, rebasing, a blocklist — and no settlement
    ///         should be trusted until someone has found out why.
    function escrowSolvency() external view returns (uint256 owed, uint256 held, uint256 surplus) {
        // BOTH liabilities. `totalEscrowed` is money owed to jobs still
        // running; `totalWithdrawable` is money already earned and not yet
        // collected. Reporting only the first would show a contract holding a
        // large "surplus" that is in fact entirely spoken for — a solvency
        // number that flatters is worse than none.
        owed = totalEscrowed + totalWithdrawable;
        held = usdcBalance();
        surplus = held > owed ? held - owed : 0;
    }

    /// @dev A staticcall rather than an interface method, so `IERC20` above
    ///      stays the two functions this contract actually needs to send money.
    ///      Returns 0 if the token does not answer, which reads as insolvent —
    ///      the safe direction for an alarm.
    function usdcBalance() public view returns (uint256) {
        (bool ok, bytes memory data) =
            address(usdc).staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        return ok && data.length >= 32 ? abi.decode(data, (uint256)) : 0;
    }

    /// @notice What silence would cost, if the requester lets the review window
    ///         run out.
    /// @dev    For the requester's own UI, more than for anyone else: a charge
    ///         a party cannot see before it is levied is a penalty, and a
    ///         penalty is not what this is. It should be possible to read the
    ///         price of doing nothing while there is still time to do
    ///         something. Same waterfall as the release, so a lender can also
    ///         see what it recovers on this path.
    ///         Status-aware for the same reason as `releaseSplit`: silence can
    ///         only cost a requester while the job is actually awaiting review.
    function expirySplit(uint256 jobId)
        external
        view
        returns (uint256 toRequester, uint256 toPayee, uint256 toWorker)
    {
        Job storage job = jobs[jobId];
        if (job.status != Status.Submitted) return (0, 0, 0);
        uint256 forfeit = (job.bounty * SILENCE_FORFEIT_BPS) / 10_000;
        toRequester = job.bounty - forfeit;
        if (job.payee != address(0)) toPayee = forfeit < job.payeeAmount ? forfeit : job.payeeAmount;
        toWorker = forfeit - toPayee;
    }
}
