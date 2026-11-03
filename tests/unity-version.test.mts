import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { UnityVersion } from '../dist/unity-version.js';

describe('UnityVersion', () => {
    it('normalizes Unity versions with build metadata', () => {
        const version = new UnityVersion('2021.3.5f1');

        // Ensure creating the version doesn't throw and comparisons use build metadata
        const f2 = new UnityVersion('2021.3.5f2');
        assert.ok((UnityVersion.compare(f2, version)) > 0);
    });

    it('parses embedded changeset from version (changeset) strings', () => {
        const version = new UnityVersion('5.6.7f1 (e80cc3114ac1)');
        assert.equal(version.version, '5.6.7f1');
        assert.equal(version.changeset, 'e80cc3114ac1');
        assert.equal(version.isFullyQualified(), true);
        assert.equal(version.toString(), '5.6.7f1 (e80cc3114ac1)');
    });

    it('keeps explicit changeset over embedded parenthetical', () => {
        const version = new UnityVersion('5.6.7f1 (e80cc3114ac1)', 'aaaaaaaaaaaa');
        assert.equal(version.version, '5.6.7f1');
        assert.equal(version.changeset, 'aaaaaaaaaaaa');
    });

    it('orders Unity builds by channel and revision', () => {
        const alpha = new UnityVersion('2021.3.5a1');
        const beta = new UnityVersion('2021.3.5b1');
        const patch = new UnityVersion('2021.3.5p1');
        const final = new UnityVersion('2021.3.5f2');
        const previousFinal = new UnityVersion('2021.3.5f1');
        // f > p > b > a
        assert.ok((UnityVersion.compare(beta, alpha)) > 0);
        assert.ok((UnityVersion.compare(patch, beta)) > 0);
        assert.ok((UnityVersion.compare(final, patch)) > 0);
        assert.ok((UnityVersion.compare(final, previousFinal)) > 0);
        // explicit check: f2 should be newer than f1
        const f2 = new UnityVersion('2021.3.5f2');
        const f1 = new UnityVersion('2021.3.5f1');
        assert.ok((UnityVersion.compare(f2, f1)) > 0);
        // patch should be older than final
        assert.ok((UnityVersion.compare(patch, final)) < 0);
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

        assert.equal(match.version, '2021.3.5f2');
        const older = new UnityVersion('2021.3.5f1');
        assert.ok((UnityVersion.compare(match, older)) > 0);
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
        assert.equal(match.version, '2021.3.2b1');
        const older = new UnityVersion('2021.3.2a1');
        assert.ok((UnityVersion.compare(match, older)) > 0);
    });

    it('finds latest final release when only major is provided', () => {
        const available = [
            '2021.3.5f2',
            '2021.3.0f1',
            '2020.3.7f1',
            '2021.2.9f1'
        ];

        const version = new UnityVersion('2021');
        const match = version.findMatch(available);

        assert.equal(match.version, '2021.3.5f2');
    });

    it('finds latest minor when using wildcard', () => {
        const available = [
            '2021.2.9f1',
            '2021.3.5f2',
            '2021.3.4f1'
        ];

        const version = new UnityVersion('2021.*');
        const match = version.findMatch(available);

        assert.equal(match.version, '2021.3.5f2');
    });

    it('prefers newer patch channels when allowed', () => {
        const available = [
            '2021.3.4f1',
            '2021.3.5p2'
        ];

        const version = new UnityVersion('2021.3');
        const match = version.findMatch(available, ['f', 'p']);

        assert.equal(match.version, '2021.3.5p2');
    });

    it('throws when no channel candidates exist', () => {
        const available = [
            '2021.3.5f2'
        ];

        const version = new UnityVersion('2021.3.x');
        assert.throws(() => version.findMatch(available, ['a']), /No Unity release matching/);
    });

    it('throws when explicit minor has no matching releases', () => {
        const available = [
            '6000.3.0f1'
        ];

        const version = new UnityVersion('6000.0.x');
        assert.throws(() => version.findMatch(available), /No Unity release matching/);
    });

    it('throws for stable channel when only beta exists (6000.6)', () => {
        const available = [
            '6000.6.0b7',
            '6000.5.7f1',
            '6000.7.0a4',
        ];
        const version = new UnityVersion('6000.6');
        assert.throws(() => version.findMatch(available, ['f']), /No stable \(f\) release/);
    });

    it('resolves beta channel for 6000.6 when only b releases exist', () => {
        const available = [
            '6000.6.0b5',
            '6000.6.0b7',
            '6000.5.7f1',
        ];
        const version = new UnityVersion('6000.6');
        const match = version.findMatch(available, ['b']);
        assert.equal(match.version, '6000.6.0b7');
    });

    it('evaluates caret compatibility with satisfies', () => {
        const baseline = new UnityVersion('2021.3.5f1');
        const compatible = new UnityVersion('2021.4.0f1');
        const incompatible = new UnityVersion('2022.1.0f1');

        assert.equal(baseline.satisfies(compatible), true);
        assert.equal(baseline.satisfies(incompatible), false);
    });

    it('evaluates semantic version ranges using range()', () => {
        const version = new UnityVersion('2021.3.5f1');

        assert.equal(version.range('>=2021.3.0 <2021.4.0'), true);
        assert.equal(version.range('<2021.3.0'), false);
    });

    it('compares versions with helper predicates', () => {
        const older = new UnityVersion('2021.3.5f1');
        const newer = new UnityVersion('2021.3.6f1');

        assert.equal(newer.isGreaterThan(older), true);
        assert.equal(newer.isGreaterThan('2021.3.5f1'), true);
        assert.equal(newer.isGreaterThanOrEqualTo('2021.3.6f1'), true);
        assert.equal(older.isGreaterThanOrEqualTo(newer), false);
        assert.equal(older.isLessThan(newer), true);
        assert.equal(older.isLessThanOrEqualTo('2021.3.5f1'), true);
        assert.equal(newer.isLessThanOrEqualTo(older), false);
    });
});
