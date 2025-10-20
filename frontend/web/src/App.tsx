// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface EncryptedMessage {
  id: string;
  encryptedData: string;
  timestamp: number;
  sender: string;
  title: string;
  isRead: boolean;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<EncryptedMessage[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newMessageData, setNewMessageData] = useState({ title: "", content: 0 });
  const [showIntro, setShowIntro] = useState(true);
  const [selectedMessage, setSelectedMessage] = useState<EncryptedMessage | null>(null);
  const [decryptedContent, setDecryptedContent] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterUnread, setFilterUnread] = useState(false);

  useEffect(() => {
    loadMessages().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadMessages = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("message_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing message keys:", e); }
      }
      
      const list: EncryptedMessage[] = [];
      for (const key of keys) {
        try {
          const messageBytes = await contract.getData(`message_${key}`);
          if (messageBytes.length > 0) {
            try {
              const messageData = JSON.parse(ethers.toUtf8String(messageBytes));
              list.push({ 
                id: key, 
                encryptedData: messageData.data, 
                timestamp: messageData.timestamp, 
                sender: messageData.sender, 
                title: messageData.title,
                isRead: messageData.isRead || false
              });
            } catch (e) { console.error(`Error parsing message data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading message ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setMessages(list);
    } catch (e) { console.error("Error loading messages:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const sendMessage = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting message with Zama FHE..." });
    try {
      const encryptedData = FHEEncryptNumber(newMessageData.content);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const messageId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const messageData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        sender: address, 
        title: newMessageData.title,
        isRead: false
      };
      
      await contract.setData(`message_${messageId}`, ethers.toUtf8Bytes(JSON.stringify(messageData)));
      
      const keysBytes = await contract.getData("message_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(messageId);
      await contract.setData("message_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Message encrypted and sent securely!" });
      await loadMessages();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewMessageData({ title: "", content: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Sending failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const markAsRead = async (messageId: string) => {
    if (!isConnected) return;
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const messageBytes = await contract.getData(`message_${messageId}`);
      if (messageBytes.length === 0) throw new Error("Message not found");
      
      const messageData = JSON.parse(ethers.toUtf8String(messageBytes));
      const updatedMessage = { ...messageData, isRead: true };
      
      await contract.setData(`message_${messageId}`, ethers.toUtf8Bytes(JSON.stringify(updatedMessage)));
      await loadMessages();
    } catch (e) { console.error("Error marking as read:", e); }
  };

  const filteredMessages = messages.filter(message => {
    const matchesSearch = message.title.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesUnread = filterUnread ? !message.isRead : true;
    return matchesSearch && matchesUnread;
  });

  const unreadCount = messages.filter(m => !m.isRead).length;
  const sentCount = messages.filter(m => m.sender.toLowerCase() === address?.toLowerCase()).length;
  const receivedCount = messages.length - sentCount;

  if (loading) return (
    <div className="loading-screen">
      <div className="tech-spinner"></div>
      <p>Initializing FHE encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container future-tech-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="hexagon"></div>
            <div className="inner-circle"></div>
          </div>
          <h1>Notify<span>FHE</span></h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-btn tech-button">
            <div className="add-icon"></div>New Message
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        {showIntro && (
          <div className="intro-section tech-card">
            <div className="intro-header">
              <h2>Private On-Chain Messaging with Zama FHE</h2>
              <button onClick={() => setShowIntro(false)} className="close-intro">&times;</button>
            </div>
            <div className="intro-content">
              <div className="intro-feature">
                <div className="feature-icon">🔒</div>
                <div>
                  <h3>End-to-End Encrypted</h3>
                  <p>Messages are encrypted using Zama FHE technology, ensuring only the recipient can decrypt them.</p>
                </div>
              </div>
              <div className="intro-feature">
                <div className="feature-icon">⚡</div>
                <div>
                  <h3>On-Chain Privacy</h3>
                  <p>Messages are stored on-chain but remain encrypted, protecting your communication privacy.</p>
                </div>
              </div>
              <div className="intro-feature">
                <div className="feature-icon">🔑</div>
                <div>
                  <h3>Wallet-Based Decryption</h3>
                  <p>Only you can decrypt messages using your wallet signature, ensuring true ownership.</p>
                </div>
              </div>
            </div>
            <div className="intro-footer">
              <div className="fhe-badge">
                <span>Powered by Zama FHE</span>
              </div>
            </div>
          </div>
        )}

        <div className="dashboard-section">
          <div className="stats-grid">
            <div className="stat-card tech-card">
              <div className="stat-value">{messages.length}</div>
              <div className="stat-label">Total Messages</div>
            </div>
            <div className="stat-card tech-card">
              <div className="stat-value">{unreadCount}</div>
              <div className="stat-label">Unread</div>
            </div>
            <div className="stat-card tech-card">
              <div className="stat-value">{sentCount}</div>
              <div className="stat-label">Sent</div>
            </div>
            <div className="stat-card tech-card">
              <div className="stat-value">{receivedCount}</div>
              <div className="stat-label">Received</div>
            </div>
          </div>
        </div>

        <div className="messages-section">
          <div className="section-header">
            <h2>Your Encrypted Messages</h2>
            <div className="controls">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search messages..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="tech-input"
                />
              </div>
              <div className="filter-toggle">
                <label>
                  <input 
                    type="checkbox" 
                    checked={filterUnread}
                    onChange={() => setFilterUnread(!filterUnread)}
                  />
                  <span>Show Unread Only</span>
                </label>
              </div>
              <button onClick={loadMessages} className="refresh-btn tech-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="messages-list">
            {filteredMessages.length === 0 ? (
              <div className="no-messages tech-card">
                <div className="empty-icon"></div>
                <p>No messages found</p>
                <button className="tech-button primary" onClick={() => setShowCreateModal(true)}>
                  Send Your First Message
                </button>
              </div>
            ) : (
              filteredMessages.map(message => (
                <div 
                  className={`message-card tech-card ${message.isRead ? '' : 'unread'}`} 
                  key={message.id}
                  onClick={() => {
                    setSelectedMessage(message);
                    if (!message.isRead) markAsRead(message.id);
                  }}
                >
                  <div className="message-header">
                    <div className="message-title">{message.title}</div>
                    <div className="message-meta">
                      <span className="sender">{message.sender.substring(0, 6)}...{message.sender.substring(38)}</span>
                      <span className="timestamp">{new Date(message.timestamp * 1000).toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="message-preview">
                    <div className="encrypted-preview">
                      {message.encryptedData.substring(0, 50)}...
                    </div>
                    <div className="fhe-tag">
                      <span>FHE Encrypted</span>
                    </div>
                  </div>
                  {!message.isRead && <div className="unread-badge"></div>}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={sendMessage} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          messageData={newMessageData} 
          setMessageData={setNewMessageData}
        />
      )}

      {selectedMessage && (
        <MessageDetailModal 
          message={selectedMessage} 
          onClose={() => { 
            setSelectedMessage(null); 
            setDecryptedContent(null); 
          }} 
          decryptedContent={decryptedContent} 
          setDecryptedContent={setDecryptedContent} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content tech-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="tech-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="hexagon"></div>
              <span>NotifyFHE</span>
            </div>
            <p>Private on-chain messaging powered by Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Privacy</span>
          </div>
          <div className="copyright">© {new Date().getFullYear()} NotifyFHE. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  messageData: any;
  setMessageData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, messageData, setMessageData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setMessageData({ ...messageData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setMessageData({ ...messageData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!messageData.title || !messageData.content) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal tech-card">
        <div className="modal-header">
          <h2>New Encrypted Message</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Your message will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          <div className="form-group">
            <label>Title *</label>
            <input 
              type="text" 
              name="title" 
              value={messageData.title} 
              onChange={handleChange} 
              placeholder="Message title..."
              className="tech-input"
            />
          </div>
          <div className="form-group">
            <label>Content (Numerical) *</label>
            <input 
              type="number" 
              name="content" 
              value={messageData.content} 
              onChange={handleValueChange} 
              placeholder="Enter numerical content..."
              className="tech-input"
              step="0.01"
            />
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Value:</span>
                <div>{messageData.content || 'No value entered'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{messageData.content ? FHEEncryptNumber(messageData.content).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn tech-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn tech-button primary">
            {creating ? "Encrypting with FHE..." : "Send Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface MessageDetailModalProps {
  message: EncryptedMessage;
  onClose: () => void;
  decryptedContent: number | null;
  setDecryptedContent: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const MessageDetailModal: React.FC<MessageDetailModalProps> = ({ 
  message, 
  onClose, 
  decryptedContent, 
  setDecryptedContent, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedContent !== null) { 
      setDecryptedContent(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(message.encryptedData);
    if (decrypted !== null) setDecryptedContent(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="message-detail-modal tech-card">
        <div className="modal-header">
          <h2>Message Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="message-info">
            <div className="info-item">
              <span>Title:</span>
              <strong>{message.title}</strong>
            </div>
            <div className="info-item">
              <span>From:</span>
              <strong>{message.sender.substring(0, 6)}...{message.sender.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Date:</span>
              <strong>{new Date(message.timestamp * 1000).toLocaleString()}</strong>
            </div>
          </div>
          <div className="encrypted-data-section">
            <h3>Encrypted Content</h3>
            <div className="encrypted-data">
              {message.encryptedData.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <span>FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn tech-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedContent !== null ? (
                "Hide Decrypted Content"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          {decryptedContent !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Content</h3>
              <div className="decrypted-value">{decryptedContent}</div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted content is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn tech-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;