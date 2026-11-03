import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

function loadYaml(filePath: string): any {
    return parse(fs.readFileSync(filePath, 'utf8'));
}

describe('UTP workflow profiles', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');

    it('defines profile-aware test selection in run-unity-test-batch action', () => {
        const actionPath = path.join(repoRoot, '.github', 'actions', 'run-unity-test-batch', 'action.yml');
        const action = loadYaml(actionPath);

        assert.equal(action.inputs['test-profile'].default, 'normal');
        assert.equal(action.inputs['tests-input'].default, '');

        const prepareStep = action.runs.steps.find((step: any) => step.name === 'Prepare test list and install packages');
        assert.notEqual(prepareStep, undefined);
        assert.ok(prepareStep.run.includes('case "$test_profile" in'));
        assert.ok(prepareStep.run.includes('normal)'));
        assert.ok(prepareStep.run.includes('negative)'));
        assert.ok(prepareStep.run.includes('all)'));
    });

    it('wires integration workflow to normal matrix plus dedicated negative scenario run', () => {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'integration-tests.yml');
        const workflow = loadYaml(workflowPath);

        assert.equal(workflow.jobs.validate.with['utp-test-profile'], 'normal');
        assert.notEqual(workflow.jobs['validate-negative-scenarios'], undefined);
        assert.equal(workflow.jobs['validate-negative-scenarios'].with['utp-test-profile'], 'negative');
    });
});
