
import { initializeApp } from "firebase/app";
import {getAuth, GoogleAuthProvider} from "firebase/auth"
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_APIKEY,
  authDomain: "fresherai-5e0c7.firebaseapp.com",
  projectId: "fresherai-5e0c7",
  storageBucket: "fresherai-5e0c7.firebasestorage.app",
  messagingSenderId: "1021832157665",
  appId: "1:1021832157665:web:be32d0a512a94b4d159aa0"
};


const app = initializeApp(firebaseConfig);

const auth = getAuth(app)

const provider = new GoogleAuthProvider()

export {auth , provider}