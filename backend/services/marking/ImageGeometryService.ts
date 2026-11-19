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
        return `You are a strict Pre-flight Quality Inspector for an academic exam & homework grading system.
Your job is to analyze the provided image of student homework or exam booklet and return a strict JSON response containing quality, subject, and layout metadata.

# Requirements
1. visual_observations (string): A brief Chain-of-Thought scratchpad (maximum 40 words). Describe the general clarity of the text, the academic subject (Mathematics, GCSE English Language, etc.), and whether you see a physical spine or line dividing two distinct pages side-by-side. Do NOT transcribe the entire page.

2. is_acceptable_quality (boolean): Must be false if the image is extremely blurry, completely unreadable, photographed at an extreme skewed angle, or contains more than 2 pages squeezed into a single photo. Otherwise true.
3. is_two_page_spread (boolean): Must be true ONLY if the image is a wide/landscape capture showing two FULL, complete pages side-by-side (roughly 50% left page and 50% right page separated by a central spine/fold) where BOTH pages are meant to be read and graded. CRITICAL: If the photo is a single portrait page where the booklet spine or a partial edge/corner of the adjacent page is merely peeking into the left or right margin, you MUST return false.
4. is_marking_scheme (boolean): Must be true ONLY if the image is an official marking scheme, mark scheme table, or rubric containing explicit grading codes (e.g., M1, A1, B1, AO1, AO2, AO3, Level 4 Perceptive), mark scheme table columns (e.g., "Question | Answers | Extra information | Mark | AO / Spec. Ref."), examiner guidance phrases (e.g., "allow", "ignore", "do not accept", "any two from"), structural mark distributions, or evaluator notes. CRITICAL EXCEPTION: Standard exam cover pages or title pages containing student name fields, candidate signatures, and "For Examiner's Use" mark tally grids are NOT marking schemes; return false for these. CRITICAL: Do NOT eject pages that contain large maps, graphs, reading insert extracts (Source A / Source B), or diagrams. You must scan the entire page. If there are question numbers (e.g., '1.1.1', '01', '02', 'Q5'), reading extracts, or student answer spaces beneath the image, it is an active exam page and MUST be kept in the array. Do not assume a page is a marking scheme just because it lacks handwritten student work.
5. is_supported_doc (boolean): Classify whether the document can be graded **without a mark scheme** (Maths & English Language), **requires a mark scheme** (all other academic subjects), or is **non-academic**:
   - **BUILT-IN SUBJECTS — NO MARK SCHEME REQUIRED (MUST SET \`is_supported_doc: true\`)**:
     1. **Mathematics / Further Maths / Statistics / Numeracy** (GCSE, IGCSE, A-Level, homework, working, graphs, geometry). Set \`detected_subject: "MATHS"\`.
     2. **GCSE / IGCSE / A-Level English Language** (AQA 8700, Edexcel 1EN0, OCR J351, reading inserts Source A / Source B, comprehension, language/structure analysis, creative/transactional writing Q5). Set \`detected_subject: "ENGLISH_LANGUAGE"\`.
   - **ALL OTHER ACADEMIC SUBJECTS — SUPPORTED WITH MARK SCHEME (MUST SET \`is_supported_doc: false\` AND \`detected_subject: "UNSUPPORTED_SUBJECT"\` / \`"ENGLISH_LITERATURE"\` as appropriate)**:
     - **English Literature** (AQA 8702, Edexcel 1ET0, Macbeth, A Christmas Carol, An Inspector Calls, poetry essays). Set \`detected_subject: "ENGLISH_LITERATURE"\`.
     - **Science Subjects** (Biology, Chemistry, Physics, Combined Science like AQA 8461/8464, Edexcel 1BI0/1SC0). Set \`detected_subject: "UNSUPPORTED_SUBJECT"\` and \`unsupported_subject_name: "Combined Science: Trilogy"\` (or Biology/Chemistry/Physics, WITHOUT any "GCSE" or "A-Level" prefix).
     - **All Other Academic Subjects** (History, Geography, Computer Science, ICT, Economics, Business Studies, Accounting, Psychology, Sociology, Religious Education, Law, Engineering, Food Technology, Art, Music, PE, French, Spanish, German, Arabic, etc., at any school, GCSE, A-Level, IB, BTEC, or university level). Set \`detected_subject: "UNSUPPORTED_SUBJECT"\` and provide \`unsupported_subject_name\` (e.g. "Geography", "Accounting", "Religious Education", WITHOUT any "GCSE" or "A-Level" prefix).
   - **EXAM COVER PAGES, FORMULA SHEETS & READING INSERTS**:
     - If the page is a standard exam booklet cover page (with exam board logos, candidate name/number boxes, and "Instructions for Candidates"), formula sheet, or reading insert, classify \`detected_subject\` and \`unsupported_subject_name\` according to the exam subject printed on the page (e.g., \`"MATHS"\`, \`"ENGLISH_LANGUAGE"\`, or \`"UNSUPPORTED_SUBJECT"\` with \`"Biology"\`), NEVER \`"NON_ACADEMIC"\`.
   - **NON-ACADEMIC CONTENT (CRITICAL: MUST SET \`is_supported_doc: false\` AND \`detected_subject: "NON_ACADEMIC"\`)**:
     - ONLY set \`"NON_ACADEMIC"\` when the image is unmistakably NOT academic/educational work: parking instructions, venue directions, arrival times/rules, checklists, personal receipts/invoices, banknotes, selfies, menus, random photos, or general non-educational documents.
     - Set \`detected_subject: "NON_ACADEMIC"\`, \`unsupported_subject_name: ""\`, and \`rejection_reason: "Not educational exam content: Please upload an academic exam question or student homework."\`.
   - **ZERO-FALSE-POSITIVE GUARD FOR ALL ACADEMIC SUBJECTS**:
     - If a Maths question uses a science context (e.g., bacteria growth rates, magnification, density, or physics word problems) or an English Language reading extract talks about nature or science, you **MUST** set \`is_supported_doc: true\` and \`detected_subject: "MATHS"\` or \`"ENGLISH_LANGUAGE"\`.
     - If an academic exam question or homework problem uses a real-world object as its context (e.g., a mock receipt/invoice in an Accounting, Business, or Maths question; a car-park fee problem in Maths; a newspaper/magazine extract in English or Media Studies; a diagram or map in Geography/Biology), it is **ACADEMIC** (classify by its subject), **NEVER** \`"NON_ACADEMIC"\`.
     - When in doubt between an academic subject and \`"NON_ACADEMIC"\`, prefer the academic subject rather than falsely rejecting legitimate student work.

6. detected_subject ("MATHS" | "ENGLISH_LANGUAGE" | "ENGLISH_LITERATURE" | "UNSUPPORTED_SUBJECT" | "NON_ACADEMIC"):
   - Set to \`"ENGLISH_LANGUAGE"\` for English Language.
   - Set to \`"ENGLISH_LITERATURE"\` for English Literature.
   - Set to \`"UNSUPPORTED_SUBJECT"\` for academic Sciences, Humanities, or other academic subjects.
   - Set to \`"NON_ACADEMIC"\` for non-academic content (parking notices, venue guides, receipts, selfies, general non-exam notices).
   - Otherwise default to \`"MATHS"\`.

7. unsupported_subject_name (string): 
   - If \`detected_subject === "ENGLISH_LITERATURE"\`, set to \`"English Literature"\`.
   - If \`detected_subject === "UNSUPPORTED_SUBJECT"\`, set to the detected subject name (e.g., \`"Biology"\`, \`"Chemistry"\`, \`"Physics"\`, \`"History"\`, \`"Geography"\`). Otherwise \`""\`.

8. paper_code_hint (string): Only output a paper component code (e.g., "1MA1/1H", "1MA1/2H", "8700/1", "8700/2", "8702/1", "8461/1H") when the paper/component number (/1H, /2H, Paper 1, Paper 2, etc.) is EXPLICITLY printed on that page (usually the front cover). NEVER guess or default to "1MA1/1H" when an inner page only prints "1MA1" or a printer barcode like "P76925A02024". If only a printer booklet code like "P76925A02024" is printed in the footer/margin, return "P76925A" or "". Otherwise "".

8b. paper_total_marks_hint (integer | null): ONLY if this page explicitly prints the total/maximum mark for the WHOLE paper (typically the cover page, e.g. "The maximum mark for this paper is 100", "The total mark for this paper is 80", "Total for paper: 60 marks"), return that integer. Do NOT use per-question marks or mark tally grids. Otherwise null.

8c. is_cover_page (boolean): True ONLY if this page is an official exam booklet front cover / title page (with candidate name/centre number boxes and exam instructions, and NO exam question 1 content). Otherwise false.

8d. booklet_page_number (integer | null): If a printed booklet page number is visible in the top/bottom margin or barcode (e.g. "2", "Page 3 of 24", "*P75123A0224*" where 02 is page 2), return that integer (1 to 60). Otherwise null.

8e. first_question_number (integer | null): If a main printed exam question number is visible on this page (e.g. Question 1, 2, ... 25), return the lowest main question number integer on this page. Otherwise null.

8f. is_unofficial_or_practice_paper (boolean): Set to true ONLY if the DOCUMENT ITSELF (cover page, header, footer, watermark, or bottom disclaimer) is an unofficial/third-party practice, mock, predicted, or rewritten paper (e.g., "Practice Paper", "June 2024 Format", "modelled on", "rewritten questions", "Not produced or endorsed by AQA/Edexcel", or third-party logos/footers like "* markme", "SaveMyExams", "Physics & Maths Tutor"). CRITICAL: Do NOT set true for genuine official exam board past papers (AQA, Pearson Edexcel, OCR, WJEC, Eduqas, CIE/Cambridge) and NEVER set true merely because an exam question's text contains words like "independent variable" or "practice". Otherwise false.

8g. unofficial_reason (string): If \`is_unofficial_or_practice_paper\` is true, quote the short verbatim phrase/brand seen on the page (e.g. "Practice Paper / MarkMe / Not produced or endorsed by AQA"). Otherwise "".

9. rejection_reason (string):
   - If \`detected_subject === "NON_ACADEMIC"\` or non-academic content:
     Return: \`"Not educational exam content: Please upload an academic exam question or student homework."\`
   - If \`detected_subject === "ENGLISH_LITERATURE"\`:
     Return: \`"GCSE English Literature (Macbeth, A Christmas Carol, An Inspector Calls) is currently in beta and launching soon! Right now, we fully support GCSE & A-Level Mathematics and GCSE English Language (8700 / 1EN0 / J351) with verified official mark schemes and grade boundaries."\`
   - If \`detected_subject === "UNSUPPORTED_SUBJECT"\` and \`unsupported_subject_name\`:
     Return: \`"Unsupported subject (" + unsupported_subject_name + "): Marking scheme required for this subject."\`
   - If \`is_acceptable_quality\` is false, provide a short, user-friendly quality reason.
   - If \`is_supported_doc\` is false for another reason (e.g. non-academic invoice/banknote/selfie), return: \`"Not educational exam content: Please upload an academic exam question or student homework."\`
   - Otherwise \`""\`.

10. evidence_text_snippet (string): If you set \`is_supported_doc\` to false, provide the first 20 words as proof. Otherwise omit or leave empty.
11. has_handwriting (boolean): True if the page contains visible student handwritten answers, student working, or typed student responses filled into answer spaces (NOT just printed exam questions or a candidate name on a cover page). Otherwise false.
12. has_printed_questions (boolean): True if printed exam question text/instructions/prompts are visible on this page. False if the page is a blank/cover page OR contains ONLY student answers/essays with question numbers (e.g. lined paper or typed answers with "Q1", "Q5" but no printed exam question text).
13. exam_board (string): Official exam board printed or clearly identifiable on this page (e.g. "Pearson Edexcel", "AQA", "OCR", "WJEC", "Eduqas", "CIE", "IB"). Otherwise "".

# Output Format
Return ONLY valid JSON matching this schema:
{
    "visual_observations": string,
    "is_acceptable_quality": boolean,
    "rejection_reason": string,
    "is_two_page_spread": boolean,
    "is_marking_scheme": boolean,
    "is_supported_doc": boolean,
    "detected_subject": "MATHS" | "ENGLISH_LANGUAGE" | "ENGLISH_LITERATURE" | "UNSUPPORTED_SUBJECT" | "NON_ACADEMIC",
    "unsupported_subject_name": string,
    "exam_board": string,
    "paper_code_hint": string,
    "paper_total_marks_hint": number | null,
    "is_cover_page": boolean,
    "has_handwriting": boolean,
    "has_printed_questions": boolean,
    "booklet_page_number": number | null,
    "first_question_number": number | null,
    "is_unofficial_or_practice_paper": boolean,
    "unofficial_reason": string,
    "evidence_text_snippet": string
}`;
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
            }

            // Double-guard: If the AI classified the subject as ENGLISH_LANGUAGE or MATHS, it is by definition supported!
            const isSupportedBySubject = parsed.detected_subject === 'MATHS' || parsed.detected_subject === 'ENGLISH_LANGUAGE';
            const isSupportedDoc = isSupportedBySubject ? true : (parsed.is_supported_doc === undefined ? true : Boolean(parsed.is_supported_doc));

            return {
                is_acceptable_quality: Boolean(parsed.is_acceptable_quality),
                rejection_reason: parsed.rejection_reason || undefined,
                needs_rotation: 0, // Rotation is handled by Vision now
                is_two_page_spread: Boolean(parsed.is_two_page_spread) && isPhysicallyLandscape,
                is_marking_scheme: Boolean(parsed.is_marking_scheme),
                is_supported_doc: isSupportedDoc,
                evidence_text_snippet: parsed.evidence_text_snippet || undefined,
                detected_subject: parsed.detected_subject || undefined,
                unsupported_subject_name: parsed.unsupported_subject_name
                    ? cleanSubjectAndQualification(parsed.unsupported_subject_name).subject || parsed.unsupported_subject_name
                    : undefined,
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
