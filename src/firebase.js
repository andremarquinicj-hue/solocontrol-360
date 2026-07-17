// ============================================================
// CONFIGURAÇÃO DO FIREBASE — Solocontrol 360
// ============================================================
import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'

export const firebaseConfig = {
  apiKey: "AIzaSyATCpD6Cr2tgUNRt5IONPSrZN7NaLG2jro",
  authDomain: "solocontrol-360.firebaseapp.com",
  projectId: "solocontrol-360",
  storageBucket: "solocontrol-360.firebasestorage.app",
  messagingSenderId: "245160257376",
  appId: "1:245160257376:web:144257b4697c594b74a005"
}

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)

// Persistência offline: tudo que for digitado salva no aparelho na hora
// e sincroniza com a nuvem automaticamente quando houver internet.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
})

export const storage = getStorage(app)
