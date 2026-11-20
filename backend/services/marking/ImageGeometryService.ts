import { ModelProvider, type ModelPhase } from '../../utils/ModelProvider.js';
import { ModelType } from '../../types/index.js';
import { cleanSubjectAndQualification } from './MarkingHelpers.js';

export interface GeometryAnalysisResult {
    is_acceptable_quality: boolean;
    rejection_reason?: string;
    needs_rotation: number;
    is_two_page_spread: boolean;
    is_marking_scheme: boolean;
    is_supported_doc?: boolean;
    evidence_text_snippet?: string;
    detected_subject?: 'MATHS' | 'ENGLISH_LANGUAGE' | 'ENGLISH_LITERATURE' | 'UNSUPPORTED_SUBJECT' | 'NON_ACADEMIC';
    unsupported_subject_name?: string;
    /** Official exam board if printed/identifiable on the page (e.g. "Pearson Edexcel", "AQA", "OCR", "WJEC", "Eduqas", "CIE"). */
    exam_board?: string;
    paper_code_hint?: string;
    /** Total/maximum mark for the WHOLE paper if printed on this page (usually the cover). */
    paper_total_marks_hint?: number;
    /** True if this page is an exam booklet front cover / title page. */
    is_cover_page?: boolean;
    /** True if visible handwritten or typed student answers/working are present on this page. */
    has_handwriting?: boolean;
    /** True if printed exam question text/prompts are visible on this page (false for lined-paper answers-only sheets with just Q numbers & student essays/answers). */
    has_printed_questions?: boolean;
    /** Printed booklet page number if visible (e.g. "Page 2 of 24" -> 2). */
    booklet_page_number?: number;
    /** Lowest main printed question number visible on this page (e.g. 1, 2, 20). */
    first_question_number?: number;
    /** True if the page carries third-party/unofficial branding, practice/mock/rewritten paper labels, or non-endorsement disclaimers. */
    is_unofficial_or_practice_paper?: boolean;
    /** Short verbatim phrase/brand proving why is_unofficial_or_practice_paper is true (e.g. "Practice Paper - MarkMe", "Not produced or endorsed by AQA"). */
    unofficial_reason?: string;
}

export const KNOWN_ACADEMIC_SUBJECTS = new Set([
    // Mathematics & Numeracy
    'mathematics', 'maths', 'further mathematics', 'further maths', 'core maths',
    'statistics', 'numeracy', 'functional skills',
    // English
    'english', 'english language', 'english literature', 'literature',
    // Sciences
    'biology', 'chemistry', 'physics', 'science', 'combined science', 'natural sciences',
    'applied science', 'human biology', 'biochemistry', 'geology', 'environmental science',
    'environmental management', 'astronomy', 'marine science', 'earth science', 'agriculture',
    'anatomy', 'medicine', 'pharmacology', 'nursing',
    // Humanities & Social Sciences
    'history', 'ancient history', 'geography', 'religious studies', 'religious education',
    'theology', 'philosophy', 'ethics', 'economics', 'business', 'business studies',
    'accounting', 'finance', 'psychology', 'sociology', 'politics', 'government',
    'global politics', 'law', 'criminology', 'citizenship', 'classical civilisation',
    'classics', 'archaeology', 'anthropology', 'global perspectives', 'theory of knowledge',
    'critical thinking', 'general studies', 'travel and tourism',
    // Languages
    'french', 'spanish', 'german', 'latin', 'greek', 'mandarin', 'chinese', 'italian',
    'russian', 'arabic', 'urdu', 'japanese', 'korean', 'polish', 'portuguese', 'turkish',
    'bengali', 'gujarati', 'punjabi', 'welsh', 'irish', 'hebrew', 'hindi',
    'modern foreign languages', 'mfl',
    // Technology, Computing & Engineering
    'computer science', 'computing', 'information technology', 'ict',
    'information and communication technology', 'design and technology', 'dt',
    'engineering', 'electronics', 'product design', 'textiles', 'graphics',
    'resistant materials', 'food preparation', 'food technology', 'food and nutrition',
    'home economics', 'hospitality', 'catering',
    // Arts, Media & PE
    'music', 'art', 'art and design', 'fine art', 'drama', 'theatre', 'theatre studies',
    'performing arts', 'dance', 'film studies', 'photography', 'media studies',
    'physical education', 'pe', 'sport', 'sports science', 'health and social care',
    'child development'
]);

const NON_ACADEMIC_LABEL_REGEX = /\b(other|unknown|none|this subject|general|n\/a|not educational|non[- ]?academic|parking|car park|notice|rules|instructions|venue|candidate|exam info|exam information|receipt|invoice|banknote|selfie|photo|photograph|menu|ticket|timetable|seating|desk card|checklist|administrative|logistics|blank|screenshot|chat|letter|email)\b/i;

const MATHS_MECHANICS_SIGNATURE_REGEX = /\b(inextensible\s+strings?|light\s+strings?|smooth\s+pegs?|smooth\s+pulleys?|line\s+of\s+greatest\s+slope|inclined\s+plane|rough\s+plane|smooth\s+plane|coefficient\s+of\s+friction|applied\s+test|statistics\s+and\s+mechanics|pure\s+and\s+mechanics|9ma0|8ma0|wme0\d|wst0\d|7357|7356|h240|h230|9709)\b/i;
const EXPLICIT_PHYSICS_PAPER_CODE_REGEX = /\b(8463|8464|7408|7407|1ph0|1sc0|h556|h557|h156|j249|j250|0625|9702|wph1\d)\b/i;

export function isMathsMechanicsFalsePositivePhysics(raw: {
    detected_subject?: string;
    unsupported_subject_name?: string;
    visual_observations?: string;
    evidence_text_snippet?: string;
    paper_code_hint?: string;
}): boolean {
    if (raw.detected_subject !== 'UNSUPPORTED_SUBJECT') return false;
    const subj = (raw.unsupported_subject_name || '').trim().toLowerCase();
    if (!/physics|mechanics|applied\s+math/i.test(subj)) return false;
    if (/^(mechanics|applied\s+math(?:ematics|s)?)$/i.test(subj)) return true;

    const codeHint = (raw.paper_code_hint || '').trim();
    if (EXPLICIT_PHYSICS_PAPER_CODE_REGEX.test(codeHint)) return false;

    const combinedText = `${raw.visual_observations || ''} ${raw.evidence_text_snippet || ''} ${codeHint}`;
    if (EXPLICIT_PHYSICS_PAPER_CODE_REGEX.test(combinedText)) return false;

    return MATHS_MECHANICS_SIGNATURE_REGEX.test(combinedText);
}

export function isRecognizedAcademicSubject(subjectName?: string): boolean {
    if (!subjectName || typeof subjectName !== 'string') return false;
    const clean = subjectName.trim().toLowerCase().replace(/^gcse\s+|^igcse\s+|^a-?level\s+|^as-?level\s+|^ib\s+|^btec\s+/i, '').trim();
    if (clean.length < 2 || clean.length > 80) return false;
    if (NON_ACADEMIC_LABEL_REGEX.test(clean)) {
        return false;
    }
    // Exact match against known subjects (handles short codes like 'pe', 'dt', 'ict', 'mfl')
    if (KNOWN_ACADEMIC_SUBJECTS.has(clean)) {
        return true;
    }
    // Word-boundary match for compound titles (e.g. "Combined Science: Trilogy", "Religious Education (Short Course)")
    for (const known of KNOWN_ACADEMIC_SUBJECTS) {
        if (known.length >= 4 && clean.includes(known)) {
            return true;
        }
    }
    // Accept other genuine academic discipline names (e.g. "Astrophysics", "Macroeconomics", "Microbiology")
    // as long as they look like a concise subject label (1-5 alphabetic words) and are not non-academic labels.
    if (/^[a-z][a-z\s&:,/'()-]{1,48}$/i.test(clean) && clean.split(/\s+/).length <= 5) {
        return true;
    }
    return false;
}

interface RawGeometryAnalysisResult {
    visual_observations: string;
    is_acceptable_quality: boolean;
    rejection_reason: string;
    is_two_page_spread: boolean;
    is_marking_scheme: boolean;
    is_supported_doc: boolean;
    evidence_text_snippet: string;
    detected_subject?: 'MATHS' | 'ENGLISH_LANGUAGE' | 'ENGLISH_LITERATURE' | 'UNSUPPORTED_SUBJECT' | 'NON_ACADEMIC';
    unsupported_subject_name?: string;
    exam_board?: string;
    paper_code_hint?: string;
    paper_total_marks_hint?: number | string | null;
    is_cover_page?: boolean;
    has_handwriting?: boolean;
    has_printed_questions?: boolean;
    booklet_page_number?: number | string | null;
    first_question_number?: number | string | null;
    is_unofficial_or_practice_paper?: boolean;
    unofficial_reason?: string;
}

export class ImageGeometryService {
    
    private static getSystemPrompt(): string {
        return `You are a Pre-flight Quality Inspector for an academic exam & homework grading system.
Analyze the image and return ONLY valid JSON matching the schema below.

# Field Rules
1. visual_observations (string): Max 15 words noting text clarity, academic subject, and whether a vertical spine divides two full pages side-by-side. Do NOT transcribe the page.
2. is_acceptable_quality (boolean): false ONLY if extremely blurry, unreadable, extreme skew, or >2 pages squeezed into one photo. Otherwise true.
3. is_two_page_spread (boolean): true ONLY for a wide/landscape capture showing two FULL pages side-by-side (~50% left, ~50% right divided by a central fold/spine) where BOTH pages are meant to be read. Return false for a single portrait page even if a spine/adjacent margin peeks in.
4. is_marking_scheme (boolean): true ONLY for an official mark scheme or rubric table containing grading codes (M1, A1, B1, AO1–AO3, Level descriptors), table columns ("Question | Answers | Extra information | Mark"), or examiner guidance ("allow", "ignore", "oe", "cao"). Return false for exam cover pages ("For Examiner's Use" tally grids) and active exam pages with maps, diagrams, reading inserts (Source A/B), or question numbers.
5. Subject Classification (\`is_supported_doc\`, \`detected_subject\`, \`unsupported_subject_name\`):
   - **BUILT-IN SUBJECTS (set \`is_supported_doc: true\`, \`unsupported_subject_name: ""\`)**:
     * \`"MATHS"\`: Mathematics, Further Maths, Pure Maths, Statistics, Numeracy, and **Applied Maths: Mechanics** (inclined planes, blocks/particles connected by light inextensible strings over smooth pegs/pulleys, forces, friction, tension, moments, projectiles, kinematics/suvat, momentum/impulse, GPE/KE work-energy calculations, vectors, graphs, geometry) at GCSE/IGCSE/A-Level/IAL/school level.
     * \`"ENGLISH_LANGUAGE"\`: GCSE/IGCSE/A-Level English Language (AQA 8700, Edexcel 1EN0, OCR J351, reading inserts Source A/B, comprehension, language/structure analysis, transactional/creative writing).
   - **OTHER ACADEMIC SUBJECTS — REQUIRE MARK SCHEME (set \`is_supported_doc: false\`)**:
     * \`"ENGLISH_LITERATURE"\`: Set \`unsupported_subject_name: "English Literature"\` (AQA 8702, Edexcel 1ET0, Macbeth, A Christmas Carol, An Inspector Calls, poetry).
     * \`"UNSUPPORTED_SUBJECT"\`: Any other academic subject (Biology, Chemistry, Physics, Combined Science: Trilogy, History, Geography, Computer Science, ICT, Economics, Business Studies, Accounting, Psychology, Sociology, Religious Education, Law, Engineering, Design and Technology, Art, Music, PE, French, Spanish, German, Arabic, etc.). Set \`unsupported_subject_name\` to the clean subject name WITHOUT "GCSE" or "A-Level" prefix.
   - **NON-ACADEMIC CONTENT (set \`is_supported_doc: false\`, \`detected_subject: "NON_ACADEMIC"\`, \`unsupported_subject_name: ""\`)**:
     * ONLY when unmistakably NOT educational/exam work: parking/venue notices, arrival rules, personal receipts/invoices, banknotes, selfies, menus, or random photos.
   - **ZERO-FALSE-POSITIVE GUARDS**:
     * **Mechanics & Statistics vs. Physics**: Classify Mechanics (inclined planes, pulleys/pegs, inextensible strings, GPE/KE, friction, kinematics, moments, "Applied Test") & Statistics as \`"MATHS"\` (\`is_supported_doc: true\`), NEVER \`"Physics"\`, UNLESS the page explicitly prints \`"Physics"\` or a Physics paper code (\`8463\`, \`7408\`, \`1PH0\`, \`H556\`) in the header/cover or tests non-Maths physics (circuits, waves, optics, nuclear, thermal, electromagnetism).
     * **Real-World / Science Contexts & Cover Pages**: Maths/Statistics word problems using science/real-world contexts (bacteria, density, medical trials, car-park fees) or mock invoices/receipts in Maths/Accounting/Business, and official exam cover pages/formula sheets/inserts are ALWAYS academic (classify by subject, NEVER \`"NON_ACADEMIC"\`).
6. exam_board (string): Official board printed on the page ("Pearson Edexcel", "AQA", "OCR", "WJEC", "Eduqas", "CIE", "IB"), else "".
7. paper_code_hint (string): Explicit paper component code printed on the page (e.g. "1MA1/1H", "8700/1", "8461/1H", or booklet code "P76925A"). Never guess "/1H" from a bare "1MA1". Else "".
8. paper_total_marks_hint (integer | null): Total mark for the WHOLE paper ONLY if explicitly printed (usually on cover, e.g. "Total mark for this paper is 80" -> 80). Ignore per-question marks. Else null.
9. is_cover_page (boolean): true ONLY for an official exam front cover / title page with candidate details and NO Question 1 content.
10. has_handwriting (boolean): true if visible student handwritten/typed answers or working are present (excluding cover page name).
11. has_printed_questions (boolean): true if printed exam question text/prompts are visible; false for cover/blank pages or lined-paper answers-only sheets.
12. booklet_page_number (integer | null): Printed booklet page number (1–60) in margin/footer/barcode, else null.
13. first_question_number (integer | null): Lowest main printed question number (1–60) visible on this page, else null.
14. is_unofficial_or_practice_paper (boolean): true ONLY if the document header/footer/cover has third-party/unofficial practice branding ("Practice Paper", "Not produced or endorsed by AQA", "MarkMe", "SaveMyExams", "PMT"). False for official past papers.
15. unofficial_reason (string): Verbatim brand/phrase if \`is_unofficial_or_practice_paper\` is true, else "".
16. rejection_reason (string): Provide a short reason ONLY if \`is_acceptable_quality\` is false; otherwise return "".
17. evidence_text_snippet (string): First 15 words of text ONLY if \`is_supported_doc\` is false; otherwise return "".

# Output Schema
{"visual_observations":string,"is_acceptable_quality":boolean,"rejection_reason":string,"is_two_page_spread":boolean,"is_marking_scheme":boolean,"is_supported_doc":boolean,"detected_subject":"MATHS"|"ENGLISH_LANGUAGE"|"ENGLISH_LITERATURE"|"UNSUPPORTED_SUBJECT"|"NON_ACADEMIC","unsupported_subject_name":string,"exam_board":string,"paper_code_hint":string,"paper_total_marks_hint":number|null,"is_cover_page":boolean,"has_handwriting":boolean,"has_printed_questions":boolean,"booklet_page_number":number|null,"first_question_number":number|null,"is_unofficial_or_practice_paper":boolean,"unofficial_reason":string,"evidence_text_snippet":string}`;
    }

    /**
     * "Pre-flight Quality Inspector"
     * Analyzes every uploaded image BEFORE expensive OCR or classification begins.
     * Purpose:
     * 1. Detect and reject blurry, unreadable, or non-educational images (saves compute cost).
     * 2. Detect layout issues like two-page spreads.
     * 3. Detect if the user accidentally uploaded a marking scheme instead of student work.
     * 
     * @param base64Image The base64 image data to analyze
     * @param width The image width
     * @param height The image height
     * @param model The model to use (defaults to fast tier, but overridden internally)
     * @param tracker Optional usage tracker
     * @param phase Model phase for usage tracking ('preFlight' or 'preInspect')
     * @returns GeometryAnalysisResult
     */
    static async analyze(
        base64Image: string,
        width?: number,
        height?: number,
        model: ModelType | 'fast' | 'thinking' | 'pro' | 'auto' = 'fast',
        tracker?: any,
        phase: ModelPhase = 'preFlight'
    ): Promise<GeometryAnalysisResult> {
        try {
            const prompt = this.getSystemPrompt();
            
            // Print detailed prompt log if enabled
            if (process.env.LOG_GEOMETRY_SYSTEM_PROMPT === 'true') {
                console.log(`\n================ GEOMETRY SYSTEM PROMPT ================`);
                console.log(prompt);
                console.log(`========================================================\n`);
            }
            
            const response = await ModelProvider.callGeminiChat(
                prompt,
                "Analyze this image and return the JSON.",
                base64Image,
                // CRITICAL: We hardcode 'gemini-2.5-flash' here regardless of the user's selected tier (Pro/Auto).
                // Because this pre-flight check runs on EVERY single page, it acts as a cheap filter.
                // gemini-2.5-flash is extremely fast and cost-effective, preventing us from burning
                // expensive Pro or 3.7-flash tokens just to check if an image is blurry.
                'gemini-2.5-flash', 
                true, // forceJsonResponse
                tracker,
                phase
            );

            let content = response.content.trim();
            
            // Clean up markdown formatting if present
            if (content.startsWith('\`\`\`json')) {
                content = content.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
            } else if (content.startsWith('\`\`\`')) {
                content = content.replace(/\`\`\`/g, '').trim();
            }

            let parsed: RawGeometryAnalysisResult;
            try {
                parsed = JSON.parse(content) as RawGeometryAnalysisResult;
            } catch {
                const jsonBlock = content.match(/\{[\s\S]*\}/)?.[0] || content;
                const repaired = jsonBlock.replace(/,\s*([}\]])/g, '$1');
                parsed = JSON.parse(repaired) as RawGeometryAnalysisResult;
            }
            
            // Print pretty JSON if enabled, otherwise print single line
            if (process.env.DEBUG_SEMANTIC_GEOMETRY === 'true') {
                if (process.env.LOG_GEOMETRY_SYSTEM_PROMPT === 'true') {
                    console.log(`\n🤖 [SEMANTIC GEOMETRY AI DEBUG] Pretty Response:\n${JSON.stringify(parsed, null, 2)}\n`);
                } else {
                    console.log(`🤖 [SEMANTIC GEOMETRY AI DEBUG] Response for image: ${JSON.stringify(parsed)}`);
                }
            }

            // Deterministic physical geometry guard: An upright side-by-side 2-page spread MUST be wider than it is tall.
            const isPhysicallyLandscape = (width && height) ? (width > height * 1.05) : true;

            // Strict Non-Academic / Administrative / Logistical Content Guard:
            // Parking directions, venue rules, arrival instructions, receipts, selfies, etc.
            // Note: Do NOT include "instructions for candidate" because standard GCSE/A-Level exam cover pages print that phrase.
            const observationText = `${parsed.visual_observations || ''} ${parsed.evidence_text_snippet || ''} ${parsed.rejection_reason || ''}`.toLowerCase();
            const hasRecognizedAcademicSubject =
                parsed.detected_subject === 'MATHS' ||
                parsed.detected_subject === 'ENGLISH_LANGUAGE' ||
                parsed.detected_subject === 'ENGLISH_LITERATURE' ||
                (parsed.detected_subject === 'UNSUPPORTED_SUBJECT' && isRecognizedAcademicSubject(parsed.unsupported_subject_name));

            const isNonAcademicContent =
                parsed.detected_subject === 'NON_ACADEMIC' ||
                (!hasRecognizedAcademicSubject &&
                    /parking|car park|arrival time|doors open|venue direction|desk card|receipt|invoice|banknote|selfie/i.test(observationText));

            if (isNonAcademicContent) {
                parsed.detected_subject = 'NON_ACADEMIC';
                parsed.is_supported_doc = false;
                parsed.unsupported_subject_name = '';
                parsed.rejection_reason = 'Not educational exam content: Please upload an academic exam question or student homework.';
            } else if (parsed.detected_subject === 'UNSUPPORTED_SUBJECT' && !isRecognizedAcademicSubject(parsed.unsupported_subject_name)) {
                // If it was flagged as unsupported subject but the subject is not a genuine academic discipline, classify as non-academic
                parsed.detected_subject = 'NON_ACADEMIC';
                parsed.is_supported_doc = false;
                parsed.unsupported_subject_name = '';
                parsed.rejection_reason = 'Not educational exam content: Please upload an academic exam question or student homework.';
            } else if (isMathsMechanicsFalsePositivePhysics(parsed)) {
                // Deterministic guard: A-Level / Applied Maths Mechanics problem misclassified as Physics
                parsed.detected_subject = 'MATHS';
                parsed.is_supported_doc = true;
                parsed.unsupported_subject_name = '';
                parsed.rejection_reason = '';
            }

            // Double-guard: If the AI classified the subject as ENGLISH_LANGUAGE or MATHS, it is by definition supported!
            const isSupportedBySubject = parsed.detected_subject === 'MATHS' || parsed.detected_subject === 'ENGLISH_LANGUAGE';
            const isSupportedDoc = isSupportedBySubject ? true : (parsed.is_supported_doc === undefined ? true : Boolean(parsed.is_supported_doc));
            const cleanedUnsupportedSubject = parsed.unsupported_subject_name
                ? cleanSubjectAndQualification(parsed.unsupported_subject_name).subject || parsed.unsupported_subject_name
                : undefined;

            // Deterministically populate rejection_reason for unsupported / non-academic docs so the LLM doesn't waste tokens outputting boilerplate
            let resolvedRejectionReason = (parsed.rejection_reason || '').trim();
            if (!resolvedRejectionReason && !isSupportedDoc) {
                if (parsed.detected_subject === 'NON_ACADEMIC') {
                    resolvedRejectionReason = 'Not educational exam content: Please upload an academic exam question or student homework.';
                } else if (parsed.detected_subject === 'ENGLISH_LITERATURE') {
                    resolvedRejectionReason = 'GCSE English Literature (Macbeth, A Christmas Carol, An Inspector Calls) is currently in beta and launching soon! Right now, we fully support GCSE & A-Level Mathematics and GCSE English Language (8700 / 1EN0 / J351) with verified official mark schemes and grade boundaries.';
                } else if (parsed.detected_subject === 'UNSUPPORTED_SUBJECT' && cleanedUnsupportedSubject) {
                    resolvedRejectionReason = `Unsupported subject (${cleanedUnsupportedSubject}): Marking scheme required for this subject.`;
                } else {
                    resolvedRejectionReason = 'Not educational exam content: Please upload an academic exam question or student homework.';
                }
            } else if (isSupportedDoc && parsed.is_acceptable_quality !== false) {
                resolvedRejectionReason = '';
            }

            return {
                is_acceptable_quality: Boolean(parsed.is_acceptable_quality),
                rejection_reason: resolvedRejectionReason || undefined,
                needs_rotation: 0, // Rotation is handled by Vision now
                is_two_page_spread: Boolean(parsed.is_two_page_spread) && isPhysicallyLandscape,
                is_marking_scheme: Boolean(parsed.is_marking_scheme),
                is_supported_doc: isSupportedDoc,
                evidence_text_snippet: parsed.evidence_text_snippet || undefined,
                detected_subject: parsed.detected_subject || undefined,
                unsupported_subject_name: cleanedUnsupportedSubject,
                exam_board: parsed.exam_board ? String(parsed.exam_board).trim() : undefined,
                paper_code_hint: parsed.paper_code_hint || undefined,
                paper_total_marks_hint: (() => {
                    const n = Number(parsed.paper_total_marks_hint);
                    return Number.isInteger(n) && n >= 10 && n <= 400 ? n : undefined;
                })(),
                is_cover_page: Boolean(parsed.is_cover_page),
                has_handwriting: Boolean(parsed.has_handwriting),
                has_printed_questions: parsed.has_printed_questions === undefined ? undefined : Boolean(parsed.has_printed_questions),
                booklet_page_number: (() => {
                    const n = Number(parsed.booklet_page_number);
                    return Number.isInteger(n) && n >= 1 && n <= 100 ? n : undefined;
                })(),
                first_question_number: (() => {
                    const n = Number(parsed.first_question_number);
                    return Number.isInteger(n) && n >= 1 && n <= 100 ? n : undefined;
                })(),
                is_unofficial_or_practice_paper: Boolean(parsed.is_unofficial_or_practice_paper),
                unofficial_reason: parsed.unofficial_reason ? String(parsed.unofficial_reason).trim() : undefined
            };

        } catch (error) {
            console.error('❌ [ImageGeometryService] Failed to analyze image geometry:', error);
            // Fallback to safe defaults if the LLM fails
            return {
                is_acceptable_quality: true,
                needs_rotation: 0,
                is_two_page_spread: false,
                is_marking_scheme: false,
                is_supported_doc: true // Fall open to let OCR handle it
            };
        }
    }
}
