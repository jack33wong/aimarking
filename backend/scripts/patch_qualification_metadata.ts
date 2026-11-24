/**
 * Patch Script: Normalizes qualification, exam_board, and tier on existing
 * `fullExamPapers` and `markingSchemes` documents in Firestore (e.g. fixes
 * auto-persisted CIE 0610/41 previously stored as GCSE / Higher Tier -> IGCSE / Extended).
 *
 * Usage:
 *   cd backend && npx tsx scripts/patch_qualification_metadata.ts            # dry-run
 *   cd backend && npx tsx scripts/patch_qualification_metadata.ts --apply    # commit updates
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { getFirestore } from '../config/firebase.js';
import { ExamReferenceService } from '../services/ExamReferenceService.js';
import { NormalizationService } from '../services/marking/NormalizationService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '..', '..', '.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const applyChanges = process.argv.includes('--apply');

async function patchCollection(collectionName: 'fullExamPapers' | 'markingSchemes') {
    const db = getFirestore();
    const snapshot = await db.collection(collectionName).get();
    console.log(`\n📂 Scanning ${collectionName} (${snapshot.size} docs)...`);

    let updatedCount = 0;
    const batch = db.batch();

    snapshot.forEach((doc) => {
        const data = doc.data();
        const isPaper = collectionName === 'fullExamPapers';
        const metaField = isPaper ? 'metadata' : (data.examDetails ? 'examDetails' : 'metadata');
        const meta = data[metaField];
        if (!meta) return;

        const rawBoard = String(meta.exam_board || meta.board || '').trim();
        if (!rawBoard || /^(custom|unknown|n\/a|none)$/i.test(rawBoard)) return;

        const normBoard = NormalizationService.normalizeExamBoard(rawBoard);
        const code = String(meta.exam_code || meta.paperCode || meta.code || '').trim();
        const { qualification, tier } = ExamReferenceService.formatMetadataDisplay({
            ...meta,
            exam_board: normBoard,
            exam_code: code
        });

        const currentQual = String(meta.qualification || '').trim();
        const currentTier = String(meta.tier || '').trim();
        const currentBoard = String(meta.exam_board || meta.board || '').trim();

        const updates: Record<string, any> = {};
        if (qualification && currentQual !== qualification) {
            updates[`${metaField}.qualification`] = qualification;
        }
        if (normBoard && currentBoard !== normBoard) {
            if (meta.exam_board !== undefined) updates[`${metaField}.exam_board`] = normBoard;
            if (meta.board !== undefined) updates[`${metaField}.board`] = normBoard;
        }
        if (tier && currentTier !== tier) {
            updates[`${metaField}.tier`] = tier;
        }

        if (Object.keys(updates).length > 0) {
            updatedCount++;
            console.log(`  🔧 ${doc.id} (${code || 'no-code'})`);
            Object.entries(updates).forEach(([k, v]) => {
                const prev = k.endsWith('.qualification') ? currentQual : k.endsWith('.tier') ? currentTier : currentBoard;
                console.log(`     ${k}: "${prev}" -> "${v}"`);
            });
            if (applyChanges) {
                batch.update(doc.ref, updates);
            }
        }
    });

    if (applyChanges && updatedCount > 0) {
        await batch.commit();
        console.log(`✅ Committed ${updatedCount} updates to ${collectionName}.`);
    } else {
        console.log(`ℹ️ ${collectionName}: ${updatedCount} docs ${applyChanges ? 'updated' : 'would be updated (dry-run)'}.`);
    }
}

async function main() {
    console.log(applyChanges ? '🚀 Running in APPLY mode' : '🧪 Running in DRY-RUN mode (pass --apply to write)');
    await patchCollection('fullExamPapers');
    await patchCollection('markingSchemes');
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('❌ Patch failed:', err);
        process.exit(1);
    });
