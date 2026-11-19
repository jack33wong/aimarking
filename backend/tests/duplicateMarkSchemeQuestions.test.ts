jest.mock('../config/firebase.js', () => ({
    getFirestore: () => null
}));

import {
    MarkingSchemeParserService,
    mergeParsedSchemeChunks,
    detectDuplicateQuestionsInParsedSchemeChunks,
    assertNoDuplicateQuestionsInMarkScheme
} from '../services/marking/MarkingSchemeParserService.js';
import { ModelProvider } from '../utils/ModelProvider.js';
import { ImageUtils } from '../utils/ImageUtils.js';
import { UserFacingError } from '../utils/UserFacingError.js';

describe('Mark scheme duplicate question number detection', () => {
    it('detects duplicate question numbers reported by the parser and throws DUPLICATE_MARK_SCHEME_QUESTIONS_NOT_SUPPORTED', () => {
        const parsed = {
            examDetails: { board: 'Edexcel', subject: 'Mathematics', paperCode: 'Uploaded' },
            questions: {
                '1': { answer: '42', marks: [{ mark: 'A1', answer: '42' }] },
                '2': { answer: 'x = 5', marks: [{ mark: 'A1', answer: 'x = 5' }] }
            },
            duplicateQuestionNumbers: ['1', '2']
        };

        let caught: any;
        try {
            assertNoDuplicateQuestionsInMarkScheme(parsed, 'topic-pack-ms.pdf');
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(UserFacingError);
        expect(caught.code).toBe('DUPLICATE_MARK_SCHEME_QUESTIONS_NOT_SUPPORTED');
        expect(caught.category).toBe('user_fixable');
        expect(caught.shouldAlertAdmin).toBe(false);
        expect(caught.userMessage).toContain('topic-pack-ms.pdf');
        expect(caught.userMessage).toMatch(/duplicate question numbers/i);
        expect(caught.userMessage).toMatch(/not currently supported/i);
        expect(caught.userMessage).toMatch(/single unique marking scheme/i);
    });

    it('detects conflicting duplicate question numbers across multi-chunk mark schemes in mergeParsedSchemeChunks', () => {
        const chunk1 = {
            examDetails: { board: 'AQA', subject: 'Mathematics', paperCode: 'Uploaded' },
            subQuestionMaxScores: { '1': 2, '2': 3 },
            questions: {
                '1': {
                    answer: 'x = 4',
                    marks: [
                        { mark: 'M1', answer: 'Rearrange 3x + 5 = 17 to 3x = 12' },
                        { mark: 'A1', answer: 'x = 4' }
                    ]
                },
                '2': {
                    answer: '(x - 2)(x - 7)',
                    marks: [
                        { mark: 'M1', answer: 'Find factors of 14 summing to -9' },
                        { mark: 'A1', answer: '(x - 2)(x - 7)' }
                    ]
                }
            }
        };

        const chunk2 = {
            examDetails: { board: 'AQA', subject: 'Mathematics', paperCode: 'Uploaded' },
            subQuestionMaxScores: { '3': 2 },
            questions: {
                '3': {
                    answer: '180 degrees',
                    marks: [{ mark: 'B1', answer: 'Angles in a triangle sum to 180' }]
                }
            }
        };

        const chunk3 = {
            examDetails: { board: 'AQA', subject: 'Mathematics', paperCode: 'Uploaded' },
            subQuestionMaxScores: { '1': 3, '2': 4 },
            questions: {
                '1': {
                    answer: '37.7 cm',
                    marks: [
                        { mark: 'M1', answer: 'Calculate circumference pi * 12' },
                        { mark: 'A1', answer: '37.7 cm' }
                    ]
                },
                '2': {
                    answer: 'x = 3, y = 4',
                    marks: [
                        { mark: 'M1', answer: 'Substitute y = 3x + 1 into 2y + x = 10' },
                        { mark: 'A1', answer: 'x = 3, y = 4' }
                    ]
                }
            }
        };

        const duplicates = detectDuplicateQuestionsInParsedSchemeChunks([chunk1, chunk2, chunk3]);
        expect(duplicates).toEqual(['1', '2']);

        const merged = mergeParsedSchemeChunks([chunk1, chunk2, chunk3]);
        expect(merged.duplicateQuestionNumbers).toEqual(['1', '2']);
        expect(() => assertNoDuplicateQuestionsInMarkScheme(merged, 'compiled-ms.pdf')).toThrow(UserFacingError);
    });

    it('does NOT flag normal adjacent-chunk overlap in a single-paper mark scheme', () => {
        const chunk1 = {
            examDetails: { board: 'Edexcel', subject: 'Mathematics', paperCode: '1MA1/1H' },
            subQuestionMaxScores: { '1': 2, '2': 3 },
            questions: {
                '1': {
                    answer: 'x = 4',
                    marks: [{ mark: 'M1', answer: '3x = 12' }, { mark: 'A1', answer: 'x = 4' }]
                },
                '2': {
                    answer: '37.7 cm',
                    marks: [{ mark: 'M1', answer: 'pi * 12' }, { mark: 'A1', answer: '37.7 cm' }]
                }
            }
        };

        const chunk2 = {
            examDetails: { board: 'Edexcel', subject: 'Mathematics', paperCode: '1MA1/1H' },
            subQuestionMaxScores: { '2': 3, '3': 2 },
            questions: {
                '2': {
                    answer: '37.7 cm',
                    marks: [{ mark: 'M1', answer: 'pi * 12' }, { mark: 'A1', answer: '37.7 cm' }]
                },
                '3': {
                    answer: '24',
                    marks: [{ mark: 'B1', answer: '24' }]
                }
            }
        };

        const merged = mergeParsedSchemeChunks([chunk1, chunk2]);
        expect(merged.duplicateQuestionNumbers).toBeUndefined();
        expect(() => assertNoDuplicateQuestionsInMarkScheme(merged, '1MA1-1H-ms.pdf')).not.toThrow();
    });

    it('detects conflicting multi-subpart single-base-question (1a, 1b) across non-adjacent chunks', () => {
        const chunk1 = {
            questions: {
                '1a': { answer: 'x = 4', marks: [{ mark: 'M1', answer: '3x = 12' }, { mark: 'A1', answer: 'x = 4' }] },
                '1b': { answer: 'y = 7', marks: [{ mark: 'B1', answer: 'Substitute x = 4 into y = x + 3' }] }
            }
        };
        const chunk2 = {
            questions: {
                '2': { answer: '180 degrees', marks: [{ mark: 'B1', answer: 'Angles in a triangle' }] }
            }
        };
        const chunk3 = {
            questions: {
                '1a': { answer: '37.7 cm', marks: [{ mark: 'M1', answer: 'Calculate circumference pi * 12' }, { mark: 'A1', answer: '37.7 cm' }] },
                '1b': { answer: '113.1 cm^2', marks: [{ mark: 'M1', answer: 'Calculate area pi * 36' }] }
            }
        };

        const duplicates = detectDuplicateQuestionsInParsedSchemeChunks([chunk1, chunk2, chunk3]);
        expect(duplicates).toEqual(['1']);
    });

    it('rethrows UserFacingError from MarkingSchemeParserService.parseImagesToObject without caching or returning null', async () => {
        const lightSpy = jest.spyOn(ImageUtils, 'createLightweightCopy').mockImplementation(async (img: string) => img);
        const geminiSpy = jest.spyOn(ModelProvider, 'callGeminiChat').mockResolvedValue({
            content: JSON.stringify({
                examDetails: { board: 'Edexcel', subject: 'Mathematics', paperCode: 'Uploaded' },
                subQuestionMaxScores: { '1': 2, '2': 3 },
                questions: {
                    '1': { answer: '42', marks: [{ mark: 'A1', answer: '42' }] },
                    '2': { answer: 'x = 5', marks: [{ mark: 'A1', answer: 'x = 5' }] }
                },
                duplicateQuestionNumbers: ['1', '2']
            }),
            usageTokens: 100
        } as any);

        try {
            const dummyImages = ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='];
            await expect(
                MarkingSchemeParserService.parseImagesToObject(dummyImages, undefined, {
                    sourceFileName: 'topic-pack-scheme.pdf'
                })
            ).rejects.toMatchObject({
                name: 'UserFacingError',
                code: 'DUPLICATE_MARK_SCHEME_QUESTIONS_NOT_SUPPORTED'
            });
            expect(geminiSpy).toHaveBeenCalledTimes(1);
        } finally {
            lightSpy.mockRestore();
            geminiSpy.mockRestore();
        }
    });
});
