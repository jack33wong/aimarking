import { MarkingInstructionService } from '../services/marking/MarkingInstructionService.js';

describe('sanitizeOcrBlocks per-page fence & regexes', () => {
  it('isolates Q12 across Page 0 and Page 1 without wiping out Page 1 continuation blocks', () => {
    const blocks = [
      { id: 'p0_q11', pageIndex: 0, text: 'Q11 Find x', coordinates: { x: 10, y: 100 } },
      { id: 'p0_q12', pageIndex: 0, text: 'Q12 Solve for y', coordinates: { x: 10, y: 400 } },
      { id: 'p0_work', pageIndex: 0, text: 'y = 2x + 1', coordinates: { x: 10, y: 500 } },
      // Page 1 starts at y=50 (which is < 400 from Page 0!)
      { id: 'p1_cont', pageIndex: 1, text: 'Therefore y = 7', coordinates: { x: 10, y: 50 } },
      { id: 'p1_q13', pageIndex: 1, text: 'Q13 Calculate area', coordinates: { x: 10, y: 450 } },
      { id: 'p1_q13_work', pageIndex: 1, text: 'Area = 25', coordinates: { x: 10, y: 520 } }
    ];

    const sanitized = MarkingInstructionService.sanitizeOcrBlocks(blocks, null, '12');
    const ids = sanitized.map(b => b.id);

    expect(ids).toEqual(['p0_q12', 'p0_work', 'p1_cont']);
  });

  it('does not treat year-tagged headers like "Q1 2023" or "Q2 - 2024" as question landmarks', () => {
    const blocks = [
      { id: 'b1', pageIndex: 0, text: 'Q12 Solve the equation', coordinates: { x: 10, y: 100 } },
      { id: 'b2', pageIndex: 0, text: 'Q1 2023 reference note', coordinates: { x: 10, y: 200 } },
      { id: 'b3', pageIndex: 0, text: 'Q2 - 2024 archive tag', coordinates: { x: 10, y: 250 } },
      { id: 'b4', pageIndex: 0, text: 'x = 42', coordinates: { x: 10, y: 300 } }
    ];

    const sanitized = MarkingInstructionService.sanitizeOcrBlocks(blocks, null, '12');
    const ids = sanitized.map(b => b.id);

    expect(ids).toEqual(['b1', 'b2', 'b3', 'b4']);
  });

  it('preserves LaTeX subscripts (x_1, a_n) while filtering 3+ underscores or pure underscore lines', () => {
    const blocks = [
      { id: 'b_sub', pageIndex: 0, text: 'x_1 + a_n = 5', coordinates: { x: 10, y: 100 } },
      { id: 'b_line', pageIndex: 0, text: '__________', coordinates: { x: 10, y: 150 } },
      { id: 'b_single_u', pageIndex: 0, text: '_', coordinates: { x: 10, y: 180 } }
    ];

    const sanitized = MarkingInstructionService.sanitizeOcrBlocks(blocks, null, '1');
    expect(sanitized.map(b => b.id)).toEqual(['b_sub']);
  });

  it('falls back to unfenced pass when fences eliminate all blocks', () => {
    const blocks = [
      { id: 'b_work_above', pageIndex: 0, text: 'x = 10', coordinates: { x: 10, y: 50 } },
      { id: 'b_q12_noise', pageIndex: 0, text: 'Q12 Total for Question 12', coordinates: { x: 10, y: 500 } }
    ];

    const sanitized = MarkingInstructionService.sanitizeOcrBlocks(blocks, null, '12');
    expect(sanitized.map(b => b.id)).toEqual(['b_work_above']);
  });
});
