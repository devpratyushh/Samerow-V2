

**SameRow** is a real-time collaborative platform that combines **peer-to-peer video calling** with **synchronized media playback**. It allows users to watch YouTube videos together in perfect sync while seeing and talking to each other in a virtual room.

This project is designed to demonstrate advanced concepts in **distributed systems**, **networking**, and **real-time state management**.

## 🚀 Live Demo

* **Client:** [https://your-vercel-url.vercel.app]([https://calls.patyux.me](https://calls.patyux.me)) (Replace with your actual Vercel URL)
* **Server:** [https://samerow-v2.onrender.com](https://samerow-v2.onrender.com)

---

## 🏗️ Architecture

SameRow uses a hybrid architecture to ensure low latency for video calls and precise state synchronization for media playback.

* **Video/Audio:** Uses **WebRTC** for a direct, peer-to-peer connection between clients.
* **Signaling & State:** Uses a central **Node.js/Socket.io** server to manage room state (video timestamps, play/pause status) and broker the WebRTC handshake.


## ✨ Key Features

* **Room-Based Video Calling:** Users can join rooms via a simple ID, instantly connecting with others.
* **Synchronized Media:**
    * Embeds YouTube links directly in the room.
    * Play, pause, and seek actions are broadcast in real-time to all users in the room.
    * Automatic drift correction ensures all clients are within milliseconds of the server's authoritative timestamp.
* **Peer-to-Peer (P2P) Video:** Video and audio streams go directly between users, reducing server load and latency.
* **Smart State Management:** The server maintains a deterministic state, allowing new users to join and instantly sync to the current point in the video.

---

## 🛠️ Tech Stack

| Component | Technology | Purpose | Deployment |
| :--- | :--- | :--- | :--- |
| **Frontend** | React, Vite | UI, Video Rendering, Media Player | Vercel |
| **Backend** | Node.js, Express | Signaling Server, API | Render |
| **Real-Time** | Socket.io | Signaling, State Synchronization | - |
| **Video/Audio** | WebRTC (simple-peer) | P2P Media Streaming | - |
| **Media Player** | react-player | Unified player for YouTube, etc. | - |

---

## ⚙️ Local Development Setup

Follow these steps to run the project locally.
```bash
### Prerequisites
* Node.js (v16+)
* npm or yarn

### 1. Clone the Repository
bash
git clone [https://github.com/your-username/Samerow-V2.git](https://github.com/your-username/Samerow-V2.git)
cd Samerow-V2

2. Setup the Server
cd server
npm install
# Start the server on port 3000
node index.js

The server should now be running at http://localhost:3000.
3. Setup the Client
Open a new terminal window from the project root.
cd client
npm install

Before running, ensure the client points to your local server.
 * Open client/src/App.jsx.
 * Change the socket connection line:
   // For local development:
const socket = io('http://localhost:3000');
// For production:
// const socket = io('[https://samerow-v2.onrender.com](https://samerow-v2.onrender.com)');

Start the client development server.
npm run dev

The client should now be running at http://localhost:5173.
4. Testing
 * Open http://localhost:5173 in two separate browser tabs.
 * Enter the same room name (e.g., "test") in both tabs and join.
 * Paste a YouTube link in one tab and test the play/pause synchronization.
🔮 Future Roadmap
 * Integrate Jellyfin API: Allow users to securely stream media from their self-hosted Jellyfin servers.
 * Screen Sharing: Implement a "Screen Share" mode using WebRTC's getDisplayMedia for watching content from non-embeddable sites.
 * User Authentication: Add user accounts and private, password-protected rooms.
 * Mobile Responsiveness: Optimize the UI for mobile browsers.
📄 License
This project is open-source and available under the MIT License.

