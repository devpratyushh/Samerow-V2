import { createAccountActions } from './accountAuth';
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, GithubAuthProvider, signInWithPopup, linkWithPopup, signOut } from "firebase/auth";
import { getAnalytics, isSupported } from "firebase/analytics";

const firebaseConfig = {
    apiKey: "AIzaSyDqnNUg8dMWEKjiJmDVwokpC1uVeEhARD8",
    authDomain: "mellettem-4f7ee.firebaseapp.com",
    projectId: "mellettem-4f7ee",
    storageBucket: "mellettem-4f7ee.firebasestorage.app",
    messagingSenderId: "409365631402",
    appId: "1:409365631402:web:0ef6dfb900b93937045bd3",
    measurementId: "G-CGT8HM6GLS"
};

Object.assign(firebaseConfig, Object.fromEntries([
  ['apiKey', import.meta.env.VITE_FIREBASE_API_KEY],
  ['authDomain', import.meta.env.VITE_FIREBASE_AUTH_DOMAIN],
  ['projectId', import.meta.env.VITE_FIREBASE_PROJECT_ID],
  ['appId', import.meta.env.VITE_FIREBASE_APP_ID],
].filter(([, value]) => value)));

// Initialize Firebase
const app = initializeApp(firebaseConfig);
if (import.meta.env.VITE_ANALYTICS_ENABLED === 'true') isSupported().then(supported => { if (supported) getAnalytics(app); }).catch(() => {});

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export const githubProvider = new GithubAuthProvider();
export const accountActions = createAccountActions({ auth, providers: { 'google.com': googleProvider, 'github.com': githubProvider }, signInWithPopup, linkWithPopup, signOut });
