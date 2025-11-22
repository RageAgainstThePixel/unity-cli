import { stringDisplayWidth } from '../src/unity-logging';

describe('stringDisplayWidth', () => {
    it('treats ASCII characters as single width', () => {
        expect(stringDisplayWidth('ABC')).toBe(3);
    });

    it('treats build status emoji as double width', () => {
        expect(stringDisplayWidth('✅')).toBe(2);
        expect(stringDisplayWidth('❌')).toBe(2);
        expect(stringDisplayWidth('⏳')).toBe(2);
    });

    it('handles emoji with variation selectors', () => {
        expect(stringDisplayWidth('✔️')).toBe(2);
    });
});
