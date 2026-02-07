import { collection, query, where, getDocs, deleteDoc, doc, Timestamp } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * Cleans up chat history older than 1 month for the specified user.
 * @param {string} userId - The ID of the user to clean up history for.
 */
export const cleanupOldChatHistory = async (userId) => {
    if (!userId) return;

    try {
        console.log(`[HistoryCleanup] Starting cleanup for user: ${userId}`);

        // Calculate date 1 month ago
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

        // Firestore Timestamp
        const cutoffTimestamp = Timestamp.fromDate(oneMonthAgo);

        const historyRef = collection(db, 'users', userId, 'chatHistory');

        // Query for documents older than cutoff
        // Note: This requires a composite index if we were ordering, but for simple inequality it usually works 
        // if dependent on single field. However, sometimes Firestore complains about indexes.
        const q = query(
            historyRef,
            where('timestamp', '<', cutoffTimestamp)
        );

        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            console.log('[HistoryCleanup] No old chat history found to delete.');
            return;
        }

        console.log(`[HistoryCleanup] Found ${snapshot.size} old chat messages to delete.`);

        // Batch delete or parallel delete
        // For safety and simplicity, we'll use Promise.all with individual deletes
        // A batch has a limit of 500 operations.

        const deletePromises = snapshot.docs.map(document =>
            deleteDoc(doc(db, 'users', userId, 'chatHistory', document.id))
        );

        await Promise.all(deletePromises);

        console.log(`[HistoryCleanup] Successfully deleted ${deletePromises.length} old messages.`);

    } catch (error) {
        console.error('[HistoryCleanup] Error cleaning up old chat history:', error);
    }
};
