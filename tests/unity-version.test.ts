import { UnityVersion } from '../src/unity-version';

describe('UnityVersion', () => {
    it('normalizes Unity versions with build metadata', () => {
        const version = new UnityVersion('2021.3.5f1');

        // Ensure creating the version doesn't throw and comparisons use build metadata
        const f2 = new UnityVersion('2021.3.5f2');
        expect(UnityVersion.compare(f2, version)).toBeGreaterThan(0);
    });

    it('orders Unity builds by channel and revision', () => {
        const alpha = new UnityVersion('2021.3.5a1');
        const beta = new UnityVersion('2021.3.5b1');
        const patch = new UnityVersion('2021.3.5p1');
        const final = new UnityVersion('2021.3.5f2');
        const previousFinal = new UnityVersion('2021.3.5f1');
        // f > p > b > a
        expect(UnityVersion.compare(beta, alpha)).toBeGreaterThan(0);
        expect(UnityVersion.compare(patch, beta)).toBeGreaterThan(0);
        expect(UnityVersion.compare(final, patch)).toBeGreaterThan(0);
        expect(UnityVersion.compare(final, previousFinal)).toBeGreaterThan(0);
        // explicit check: f2 should be newer than f1
        const f2 = new UnityVersion('2021.3.5f2');
        const f1 = new UnityVersion('2021.3.5f1');
        expect(UnityVersion.compare(f2, f1)).toBeGreaterThan(0);
        // patch should be older than final
        expect(UnityVersion.compare(patch, final)).toBeLessThan(0);
    });

    it('finds latest final release when provided a partial version', () => {
        const available = [
            '2021.3.5f2',
            '2021.3.1f1',
            '2021.3.4p2',
            '2021.3.5f1',
            '2021.3.2f1 (abcdef123456)',
        ];

        const version = new UnityVersion('2021.x');
        const match = version.findMatch(available);

        expect(match.version).toBe('2021.3.5f2');
        const older = new UnityVersion('2021.3.5f1');
        expect(UnityVersion.compare(match, older)).toBeGreaterThan(0);
    });

    it('finds latest version in specified channels', () => {
        const available = [
            '2021.3.5f2',
            '2021.3.1f1',
            '2021.3.4p2',
            '2021.3.5f1',
            '2021.3.2b1',
            '2021.3.2a1',
        ];
        // f > p > b > a
        const version = new UnityVersion('2021.x');
        const match = version.findMatch(available, ['b', 'a']);
        expect(match.version).toBe('2021.3.2b1');
        const older = new UnityVersion('2021.3.2a1');
        expect(UnityVersion.compare(match, older)).toBeGreaterThan(0);
    });

    it('evaluates caret compatibility with satisfies', () => {
        const baseline = new UnityVersion('2021.3.5f1');
        const compatible = new UnityVersion('2021.4.0f1');
        const incompatible = new UnityVersion('2022.1.0f1');

        expect(baseline.satisfies(compatible)).toBe(true);
        expect(baseline.satisfies(incompatible)).toBe(false);
    });

    it('evaluates semantic version ranges using range()', () => {
        const version = new UnityVersion('2021.3.5f1');

        expect(version.range('>=2021.3.0 <2021.4.0')).toBe(true);
        expect(version.range('<2021.3.0')).toBe(false);
    });

    it('compares versions with helper predicates', () => {
        const older = new UnityVersion('2021.3.5f1');
        const newer = new UnityVersion('2021.3.6f1');

        expect(newer.isGreaterThan(older)).toBe(true);
        expect(newer.isGreaterThan('2021.3.5f1')).toBe(true);
        expect(newer.isGreaterThanOrEqualTo('2021.3.6f1')).toBe(true);
        expect(older.isGreaterThanOrEqualTo(newer)).toBe(false);
        expect(older.isLessThan(newer)).toBe(true);
        expect(older.isLessThanOrEqualTo('2021.3.5f1')).toBe(true);
        expect(newer.isLessThanOrEqualTo(older)).toBe(false);
    });
});
