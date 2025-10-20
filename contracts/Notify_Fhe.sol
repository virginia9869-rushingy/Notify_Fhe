pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract NotifyFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error BatchNotClosed();
    error InvalidCooldown();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool active;
    }
    Batch public currentBatch;

    uint256 public constant BATCH_ID_OFFSET = 1000;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PausedContract();
    event UnpausedContract();
    event CooldownSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event MessageSubmitted(address indexed provider, uint256 indexed batchId, bytes32 encryptedMessage);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 messageCount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        cooldownSeconds = 60; // Default cooldown
        currentBatch = Batch({id: BATCH_ID_OFFSET, active: false});
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit PausedContract();
    }

    function unpause() external onlyOwner {
        if (!paused) revert Paused(); // Cannot unpause if not paused
        paused = false;
        emit UnpausedContract();
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidCooldown();
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (currentBatch.active) revert BatchNotClosed();
        currentBatch.id++;
        currentBatch.active = true;
        emit BatchOpened(currentBatch.id);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!currentBatch.active) revert BatchClosed();
        currentBatch.active = false;
        emit BatchClosed(currentBatch.id);
    }

    function submitEncryptedMessage(euint32 encryptedMessage) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!currentBatch.active) revert BatchClosed();
        if (!encryptedMessage.isInitialized()) revert NotInitialized();
        lastSubmissionTime[msg.sender] = block.timestamp;
        bytes32 messageBytes = encryptedMessage.toBytes32();
        emit MessageSubmitted(msg.sender, currentBatch.id, messageBytes);
    }

    function requestBatchDecryption() external onlyOwner whenNotPaused checkDecryptionCooldown {
        if (currentBatch.active) revert BatchNotClosed(); // Must be closed to finalize
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        bytes32[] memory cts = _collectCiphertextsForDecryption();
        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({ batchId: currentBatch.id, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, currentBatch.id, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        bytes32[] memory cts = _collectCiphertextsForDecryption();
        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        // In a real scenario, cleartexts would be decoded and processed here.
        // For this example, we just count them.
        uint256 messageCount = cleartexts.length / 32; // Assuming each cleartext is 32 bytes (uint256)

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, messageCount);
    }

    function _collectCiphertextsForDecryption() internal view returns (bytes32[] memory) {
        // This is a placeholder. In a real contract, this would iterate over
        // stored encrypted messages for the current batch and convert them to bytes32.
        // For this example, we return an empty array as no messages are actually stored.
        bytes32[] memory cts = new bytes32[](0);
        return cts;
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 value) internal view returns (euint32) {
        if (!value.isInitialized()) {
            return FHE.asEuint32(0);
        }
        return value;
    }

    function _requireInitialized(euint32 value) internal pure {
        if (!value.isInitialized()) {
            revert NotInitialized();
        }
    }
}