import { UnityVersion } from '../src/unity-version';

describe('UnityVersion', () => {
    it('normalizes Unity versions with build metadata', () => {
        const version = new UnityVersion('2021.3.5f1');

        // Ensure creating the version doesn't throw and comparisons use build metadata
        const f2 = new UnityVersion('2021.3.5f2');
        expect(UnityVersion.compare(f2, version)).toBeGreaterThan(0);
    });

    it('orders Unity builds by channel and revision', () => {
        const patch = new UnityVersion('2021.3.5p1');
        const final = new UnityVersion('2021.3.5f2');
        const previousFinal = new UnityVersion('2021.3.5f1');

        expect(UnityVersion.compare(final, previousFinal)).toBeGreaterThan(0);
        // explicit check: f2 should be newer than f1
        const f2 = new UnityVersion('2021.3.5f2');
        const f1 = new UnityVersion('2021.3.5f1');
        expect(UnityVersion.compare(f2, f1)).toBeGreaterThan(0);
        expect(UnityVersion.compare(patch, final)).toBeGreaterThan(0);
    });

    it('finds latest final release when provided a partial version', () => {
        const available = [
            'Unity 2021.3.1f1',
            'Unity 2021.3.6f1 (abcdef123456)',
            'Unity 2021.3.4p2',
            'Unity 2021.3.5f2'
        ];

        const version = new UnityVersion('2021.3');
        const match = version.findMatch(available);

        expect(match.version).toBe('2021.3.6f1');
        // ensure comparison recognizes 2021.3.6f1 as newer than 2021.3.5f2
        const older = new UnityVersion('2021.3.5f2');
        expect(UnityVersion.compare(match, older)).toBeGreaterThan(0);
    });
});
