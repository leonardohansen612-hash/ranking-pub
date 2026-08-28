import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyDHsWWs0QWb7vJM1GySAInTw3q4FcIBmLs',
  authDomain: 'ranking-tv-pub.firebaseapp.com',
  projectId: 'ranking-tv-pub',
  storageBucket: 'ranking-tv-pub.firebasestorage.app',
  messagingSenderId: '619274801134',
  appId: '1:619274801134:web:c291999add2ee2d3bc8ff'
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
