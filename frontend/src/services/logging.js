import { db } from '../firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

export const logActivity = async (userId, userEmail, action, details = '') => {
    try {
        await addDoc(collection(db, 'activity_logs'), {
            userId,
            userEmail,
            action, // 'LOGIN', 'CHAT', 'FEEDBACK'
            details,
            timestamp: serverTimestamp()
        });
    } catch (error) {
        console.error("Error logging activity:", error);
        // Fail silently to not disrupt user experience
    }
};
