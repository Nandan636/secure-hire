# FresherAI — Multi-Agent AI Interview Preparation Platform

FresherAI is a full-stack web application that helps freshers prepare for job interviews using AI agents. It provides mock interviews, resume analysis, personalized learning roadmaps, and a billing system — all powered by LLMs and LangGraph multi-agent pipelines.

---

## Table of Contents

1. [Tech Stack](#tech-stack)
2. [Project Structure](#project-structure)
3. [How the System Works (Big Picture)](#how-the-system-works-big-picture)
4. [Service-by-Service Explanation](#service-by-service-explanation)
   - [Gateway](#1-gateway--port-8000)
   - [Auth Service](#2-auth-service--port-8001)
   - [Resume Service](#3-resume-service--port-8002)
   - [Interview Service](#4-interview-service--port-8003)
   - [Roadmap Service](#5-roadmap-service--port-8004)
   - [Billing Service](#6-billing-service--port-8005)
5. [How Each External API Works](#how-each-external-api-works)
   - [Firebase](#firebase)
   - [Groq (LLM)](#groq-llm-api)
   - [YouTube Data API](#youtube-data-api)
   - [Razorpay](#razorpay)
   - [Redis](#redis)
   - [MongoDB Atlas](#mongodb-atlas)
6. [Multi-Agent Pipelines (LangGraph)](#multi-agent-pipelines-langgraph)
   - [Interview Graph](#interview-graph)
   - [Roadmap Graph](#roadmap-graph)
7. [All API Endpoints](#all-api-endpoints)
8. [Environment Variables](#environment-variables)
9. [How to Run the Project](#how-to-run-the-project)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React, Vite, Redux, React Router, Tailwind CSS |
| Backend | Node.js, Express.js |
| AI / Agents | LangChain, LangGraph, Groq (LLaMA 3.3 70B) |
| Database | MongoDB Atlas (separate DB per service) |
| Cache | Redis (via Docker) |
| Auth | Firebase (Google login) |
| Payments | Razorpay |
| File Handling | Multer (PDF upload), pdf-parse (text extraction) |

---

## Project Structure

```
fresherAI/
├── frontend/                  → React app (Vite)
└── backend/
    ├── gateway/               → API Gateway (port 8000)
    ├── shared/redis/          → Shared Redis client
    └── services/
        ├── auth/              → Auth service (port 8001)
        ├── resume/            → Resume service (port 8002)
        ├── interview/         → Interview service (port 8003)
        ├── roadmap/           → Roadmap service (port 8004)
        └── billing/           → Billing service (port 8005)
```

Each service has its own:
- `index.js` — entry point
- `routes/` — API route definitions
- `controllers/` — business logic
- `models/` — MongoDB schemas
- `agents/` — LLM agent functions (where applicable)
- `graph/` — LangGraph pipeline (where applicable)
- `.env` — environment variables

---

## How the System Works (Big Picture)

```
User (Browser)
     |
     ▼
Frontend (React - port 5173)
     |
     ▼ HTTP requests
API Gateway (port 8000)
     |
     ├── isAuth middleware → checks Redis for session cookie
     |
     ├── /api/auth    → Auth Service    (8001)
     ├── /api/resume  → Resume Service  (8002)
     ├── /api/interview → Interview Service (8003)
     ├── /api/roadmap → Roadmap Service (8004)
     └── /api/billing → Billing Service (8005)
```

The frontend never talks directly to any service. Everything goes through the Gateway. The Gateway checks if the user is logged in (via Redis session) before forwarding the request.

---

## Service-by-Service Explanation

### 1. Gateway — Port 8000

The Gateway is the single entry point for all API calls from the frontend.

**What it does:**
- Receives every request from the frontend
- For auth routes (`/api/auth`), it forwards directly — no login check needed
- For all other routes, it runs the `isAuth` middleware first
- `isAuth` reads the session cookie, looks it up in Redis, and if valid, attaches the user data to the request
- Then `proxyWithHeaders` forwards the request to the correct service and adds `x-user-id` header so the service knows which user is making the request

**Why x-user-id header?**
Each microservice does not have access to the session cookie. The Gateway extracts the userId from Redis and passes it as a header so services can query the correct user's data from MongoDB.

---

### 2. Auth Service — Port 8001

Handles user login, logout, and interview coin management.

**Login flow:**
1. User logs in via Firebase on the frontend (Google or email)
2. Firebase gives the frontend an ID token
3. Frontend sends that token to `/api/auth/login`
4. Auth service verifies the token using Firebase Admin SDK
5. If user doesn't exist in MongoDB, it creates a new user with 150 free interview coins
6. A random session ID is generated using `crypto.randomUUID()`
7. Session data (userId, name, email, coins) is stored in Redis with 7-day expiry
8. Session ID is sent to the browser as an `httpOnly` cookie

**Logout flow:**
- Deletes the session from Redis
- Clears the cookie from the browser

**Interview Coins:**
- Each user starts with 150 coins
- Coins are deducted when starting an interview
- Coins are added when a payment is made via Razorpay
- Coin balance is stored in both MongoDB (permanent) and Redis (fast access)

**MongoDB User Schema:**
```
firebaseUid  → unique ID from Firebase
name         → user's display name
email        → user's email
interviewCoin → number of coins (default: 150)
```

---

### 3. Resume Service — Port 8002

Handles PDF resume upload, AI analysis, and resume data storage.

**Upload flow:**
1. User uploads a PDF file from the frontend
2. Multer middleware saves the file temporarily to the `uploads/` folder
3. `pdf-parse` library reads the file and extracts all text from the PDF
4. The extracted text is sent to the `resumeAgent`
5. `resumeAgent` sends the text to Groq LLM (LLaMA 3.3 70B) with a detailed system prompt
6. LLM returns structured JSON with: name, email, phone, skills, projects, education, experience, strengths, weaknesses, missingSkills, suggestedRole, ATS score (0-100), recommendations
7. Data is saved to MongoDB (one resume per user — updates if already exists)
8. Resume is also cached in Redis for fast retrieval
9. The uploaded PDF file is deleted from disk after processing

**Get Resume flow:**
1. Frontend requests `/api/resume/get-resume`
2. Service first checks Redis cache (`resume:userId`)
3. If found in Redis → returns immediately (fast)
4. If not in Redis → fetches from MongoDB, stores in Redis, returns data

**MongoDB Resume Schema stores:**
extractedText, score, name, email, phone, summary, skills, projects, education, experience, strengths, weaknesses, missingSkills, suggestedRole, recommendations

---

### 4. Interview Service — Port 8003

The most complex service. Uses a LangGraph multi-agent pipeline to conduct interviews question by question.

**Start Interview flow:**
1. User selects role (e.g. "Backend Developer") and type (HR or Technical)
2. Optionally attaches their resume data
3. Request hits `startInterview` controller
4. LangGraph graph is invoked with `action: "start"`
5. Graph routes to `interviewAgent`
6. `interviewAgent` calls Groq LLM with a detailed prompt
7. LLM generates exactly 6 questions with difficulty (easy/medium/hard) and timer (seconds)
8. Questions are saved to MongoDB with status `in-progress`
9. First question is returned to the frontend

**Submit Answer flow (per question):**
1. User types/speaks their answer and submits
2. Request hits `submitAnswer` controller with `interviewId` and `answer`
3. LangGraph graph is invoked with `action: "feedback"`
4. Graph routes to `feedbackAgent`
5. `feedbackAgent` calls Groq LLM with the question, answer, and difficulty
6. LLM scores the answer on 8 criteria (0-100 each): correctness, clarity, relevance, detail, efficiency, communication, problemSolving, creativity
7. LLM also gives a short human-like feedback sentence and 3 improvement tips
8. If this was the last question (`completed: true`), graph also routes to `summaryAgent`
9. `summaryAgent` analyzes all 6 questions + feedbacks and generates a final report with: overallScore, summary, strengths, weaknesses, recommendations
10. Everything is saved to MongoDB and Redis cache is cleared

**Get All Interviews:**
- Returns all interviews for the user with stats: totalInterviews, totalQuestions, completed count, averageScore
- Also calculates average scores per skill (correctness, clarity, etc.) separately for Technical and HR interviews
- Results are cached in Redis for 10 minutes

---

### 5. Roadmap Service — Port 8004

Generates a personalized learning roadmap using a 2-agent LangGraph pipeline.

**Generate Roadmap flow:**
1. User provides target role (e.g. "Full Stack Developer") and target package (e.g. "12 LPA")
2. Optionally attaches resume data (skills, missingSkills, projects, etc.)
3. LangGraph graph is invoked
4. **Agent 1 — roadmapAgent:** Calls Groq LLM with role, package, and resume data. LLM generates 8-15 learning modules in order, each with title, duration, difficulty, and description. If resume is provided, it skips skills the user already knows.
5. **Agent 2 — resourceAgent:** Takes the roadmap from Agent 1. For each module:
   - Calls Groq LLM to get the official documentation link
   - Calls YouTube Data API to find a relevant tutorial video
   - Attaches both to the module
6. Final roadmap (with YouTube links and docs) is saved to MongoDB
7. Cached in Redis for 1 hour

**YouTube search logic:**
- First tries to find a video from the "Virtual Code" YouTube channel specifically
- If not found, falls back to searching `{topic} tutorial`
- Returns the top result's title, channel name, and URL

---

### 6. Billing Service — Port 8005

Handles payments via Razorpay to buy more interview coins.

**Create Order flow:**
1. User clicks a plan (currently only "starter" plan: ₹199 for 300 coins)
2. `createOrder` controller creates a Razorpay order via Razorpay API
3. Order details are saved to MongoDB with status `created`
4. Order ID is returned to the frontend

**Verify Payment flow:**
1. After user pays on the Razorpay popup, Razorpay sends back: `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`
2. `verifyPayment` controller generates its own HMAC SHA256 signature using the secret key
3. Compares generated signature with the one from Razorpay
4. If they match → payment is genuine → status updated to `paid` in MongoDB
5. If they don't match → status set to `failed`
6. After verification, the frontend calls the auth service to add coins to the user's account

---

## How Each External API Works

### Firebase

**What it is:** Google's authentication platform.

**How it's used here:**
- Frontend uses Firebase SDK to let users log in with Google
- Firebase gives the frontend a short-lived ID token (JWT)
- The backend uses Firebase Admin SDK to verify that token is real and not tampered with
- `serviceAccountKey.json` is the private key file downloaded from Firebase Console that allows the backend to verify tokens

**Flow:**
```
User clicks "Login with Google"
  → Firebase handles the Google OAuth
  → Firebase gives frontend an ID token
  → Frontend sends token to backend
  → Backend verifies token with Firebase Admin
  → Backend creates/finds user in MongoDB
```

---

### Groq LLM API

**What it is:** Groq is a cloud AI provider that runs open-source LLMs extremely fast. This project uses LLaMA 3.3 70B model.

**How it's used here:**
- All 3 services (resume, interview, roadmap) use Groq via LangChain's `ChatGroq` class
- Model: `llama-3.3-70b-versatile`
- Temperature: 0.2 (low = more consistent, less random output)
- Every agent sends a carefully written prompt and expects JSON back
- The response is cleaned (removes markdown code blocks) and parsed with `JSON.parse()`

**Why Groq?**
- It's free to start
- Much faster than OpenAI for the same model size
- LLaMA 3.3 70B is powerful enough for structured JSON generation

---

### YouTube Data API

**What it is:** Google's API to search YouTube programmatically.

**How it's used here:**
- Only used in the Roadmap service's `resourceAgent`
- For each learning module in the roadmap, it searches YouTube for a tutorial video
- Uses the `/youtube/v3/search` endpoint with `part=snippet`, `type=video`, `maxResults=1`
- First searches for "Virtual Code {topic}" (a specific YouTube channel)
- If that channel's video isn't found, searches "{topic} tutorial" as fallback
- Returns the video URL in format: `https://www.youtube.com/watch?v={videoId}`

**Cost:** Free up to 10,000 units/day. Each search costs 100 units, so you get ~100 searches/day free.

---

### Razorpay

**What it is:** Indian payment gateway (like Stripe but for India).

**How it's used here:**
- Billing service creates a Razorpay order server-side
- Frontend opens the Razorpay payment popup using the order ID
- After payment, Razorpay sends a signature back to the frontend
- Frontend sends that signature to the backend for verification
- Backend uses HMAC SHA256 with the secret key to verify the payment is genuine (prevents fraud)

**Test mode:** Use Razorpay test credentials and test card numbers — no real money is charged.

---

### Redis

**What it is:** An in-memory key-value store. Think of it as a super-fast temporary database.

**How it's used here:**

| Key Pattern | What's stored | Expiry |
|---|---|---|
| `session:{sessionId}` | User session data (userId, name, email, coins) | 7 days |
| `resume:{userId}` | User's resume analysis data | No expiry |
| `interviews:{userId}` | All interviews + stats for a user | 10 minutes |
| `roadmap:{roadmapId}` | A specific roadmap | 1 hour |
| `userRoadmaps:{userId}` | All roadmaps for a user | 1 hour |

**Why Redis?**
- Session lookup on every request is instant (no MongoDB query needed)
- Resume and interview data is read much more often than written, so caching saves time
- Redis runs via Docker (`docker-compose up -d`)

---

### MongoDB Atlas

**What it is:** Cloud-hosted MongoDB database.

**How it's used here:**
- Each service has its own separate database (user, resume, interview, roadmap, billing)
- All use Mongoose ODM to define schemas and query data
- MongoDB is the permanent storage; Redis is the fast cache on top of it

**Pattern used everywhere:**
```
Check Redis → if found return it
             → if not found, query MongoDB, store in Redis, return it
```

---

## Multi-Agent Pipelines (LangGraph)

LangGraph is a library for building stateful, multi-step AI workflows as graphs (nodes + edges).

### Interview Graph

```
START
  |
  ▼ (router checks state.action)
  ├── action="start"    → interviewAgent → END
  └── action="feedback" → feedbackAgent
                              |
                        (feedbackRouter checks state.completed)
                              ├── completed=false → END
                              └── completed=true  → summaryAgent → END
```

**State (shared data between nodes):**
action, type, role, useResume, resume, questions, question, answer, difficulty, feedback, report, completed

**interviewNode:** Calls interviewAgent with role, type, resume → gets 6 questions back

**feedbackNode:** Calls feedbackAgent with question, answer, difficulty → gets scores + feedback back

**summaryNode:** Calls summaryAgent with all questions (including all answers and feedbacks) → gets final report back

---

### Roadmap Graph

```
START → roadmapAgent → resourceAgent → END
```

This is a simple sequential pipeline:
1. `roadmapAgent` generates the roadmap structure (modules with titles, durations, difficulty)
2. `resourceAgent` enriches each module by adding YouTube video URL and documentation link
3. The enriched roadmap is returned

**State:** role, targetPackage, useResume, resume, roadmap

---

## All API Endpoints

All routes go through the Gateway at `http://localhost:8000`

### Auth (`/api/auth`) — No login required
| Method | Endpoint | What it does |
|---|---|---|
| POST | `/api/auth/login` | Login with Firebase token, create session |
| GET | `/api/auth/logout` | Logout, delete session |
| POST | `/api/auth/use-coins` | Deduct interview coins |
| POST | `/api/auth/add-coins` | Add coins after payment |

### User (`/api/me`) — Login required
| Method | Endpoint | What it does |
|---|---|---|
| GET | `/api/me` | Get current logged-in user data |

### Resume (`/api/resume`) — Login required
| Method | Endpoint | What it does |
|---|---|---|
| POST | `/api/resume/upload` | Upload PDF, analyze with AI, save |
| GET | `/api/resume/get-resume` | Get analyzed resume data |

### Interview (`/api/interview`) — Login required
| Method | Endpoint | What it does |
|---|---|---|
| POST | `/api/interview/start` | Start new interview, get first question |
| POST | `/api/interview/answer` | Submit answer, get feedback + next question |
| GET | `/api/interview/all` | Get all interviews + stats |
| GET | `/api/interview/:id` | Get a specific interview by ID |

### Roadmap (`/api/roadmap`) — Login required
| Method | Endpoint | What it does |
|---|---|---|
| POST | `/api/roadmap/generate` | Generate new roadmap |
| GET | `/api/roadmap/all` | Get all roadmaps for user |
| GET | `/api/roadmap/:id` | Get specific roadmap by ID |

### Billing (`/api/billing`) — Login required
| Method | Endpoint | What it does |
|---|---|---|
| POST | `/api/billing/create-order` | Create Razorpay payment order |
| POST | `/api/billing/verify` | Verify payment signature |

---

## Environment Variables

### `backend/gateway/.env`
```
PORT=8000
REDIS_URL=redis://localhost:6379
AUTH_SERVICE_URL=http://localhost:8001
RESUME_SERVICE_URL=http://localhost:8002
INTERVIEW_SERVICE_URL=http://localhost:8003
ROADMAP_SERVICE_URL=http://localhost:8004
BILLING_SERVICE_URL=http://localhost:8005
FRONTEND_URL=http://localhost:5173
```

### `backend/services/auth/.env`
```
PORT=8001
MONGODB_URL=mongodb+srv://<user>:<pass>@cluster.mongodb.net/user
REDIS_URL=redis://localhost:6379
```

### `backend/services/resume/.env`
```
PORT=8002
MONGODB_URL=mongodb+srv://<user>:<pass>@cluster.mongodb.net/resume
REDIS_URL=redis://localhost:6379
GROQ_API_KEY=your_groq_api_key
```

### `backend/services/interview/.env`
```
PORT=8003
MONGODB_URL=mongodb+srv://<user>:<pass>@cluster.mongodb.net/interview
REDIS_URL=redis://localhost:6379
GROQ_API_KEY=your_groq_api_key
```

### `backend/services/roadmap/.env`
```
PORT=8004
MONGODB_URL=mongodb+srv://<user>:<pass>@cluster.mongodb.net/roadmap
REDIS_URL=redis://localhost:6379
GROQ_API_KEY=your_groq_api_key
YOUTUBE_API_KEY=your_youtube_api_key
```

### `backend/services/billing/.env`
```
PORT=8005
MONGODB_URL=mongodb+srv://<user>:<pass>@cluster.mongodb.net/billing
RAZORPAY_KEY_ID=your_razorpay_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
```

### `frontend/.env`
```
VITE_FIREBASE_APIKEY=your_firebase_api_key
VITE_RAZORPAY_KEY_ID=your_razorpay_key_id
VITE_BACKEND_URL=http://localhost:8000
```

---

## How to Run the Project

### Prerequisites
- Node.js v18+
- Docker (for Redis)
- MongoDB Atlas account (free)
- Groq account (free) → https://console.groq.com
- Firebase project (free) → https://console.firebase.google.com
- YouTube Data API v3 key (free) → https://console.cloud.google.com
- Razorpay account (free test mode) → https://dashboard.razorpay.com

### Step 1 — Fill all .env files
Fill in all the `.env` files listed above with your actual keys.

Also place your Firebase `serviceAccountKey.json` file inside `backend/services/auth/`.
Download it from: Firebase Console → Project Settings → Service Accounts → Generate New Private Key

### Step 2 — Start Redis
```bash
cd backend
docker-compose up -d
```

### Step 3 — Start all backend services
Open 6 separate terminals:

```bash
# Terminal 1
cd backend/gateway && npm install && npm start

# Terminal 2
cd backend/services/auth && npm install && npm start

# Terminal 3
cd backend/services/resume && npm install && npm start

# Terminal 4
cd backend/services/interview && npm install && npm start

# Terminal 5
cd backend/services/roadmap && npm install && npm start

# Terminal 6
cd backend/services/billing && npm install && npm start
```

### Step 4 — Start the frontend
```bash
# Terminal 7
cd frontend && npm install && npm run dev
```

### Step 5 — Open the app
Go to `http://localhost:5173` in your browser.

---

## Notes

- New users get **150 free interview coins** on signup
- Each interview costs coins (deducted via auth service)
- Buy more coins via the Billing page (Razorpay test mode)
- Resume data is reused across interview and roadmap features if "use resume" is toggled on
- The LLM model used is **LLaMA 3.3 70B** via Groq — it's free and fast
