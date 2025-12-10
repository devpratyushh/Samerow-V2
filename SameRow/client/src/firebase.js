import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getAnalytics } from "firebase/analytics";

const firebaseConfig = {
    apiKey: "AIzaSyDqnNUg8dMWEKjiJmDVwokpC1uVeEhARD8",
    authDomain: "mellettem-4f7ee.firebaseapp.com",
    projectId: "mellettem-4f7ee",
    storageBucket: "mellettem-4f7ee.firebasestorage.app",
    messagingSenderId: "409365631402",
    appId: "1:409365631402:web:0ef6dfb900b93937045bd3",
    measurementId: "G-CGT8HM6GLS"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
