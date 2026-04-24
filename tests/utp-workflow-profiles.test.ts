import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

function loadYaml(filePath: string): any {
    return parse(fs.readFileSync(filePath, 'utf8'));
}

describe('UTP workflow profiles', () => {
    const repoRoot = path.resolve(__dirname, '..');

    it('defines profile-aware test selection in run-unity-test-batch action', () => {
        const actionPath = path.join(repoRoot, '.github', 'actions', 'run-unity-test-batch', 'action.yml');
        const action = loadYaml(actionPath);

        expect(action.inputs['test-profile'].default).toBe('normal');
        expect(action.inputs['tests-input'].default).toBe('');

        const prepareStep = action.runs.steps.find((step: any) => step.name === 'Prepare test list and install packages');
        expect(prepareStep).toBeDefined();
        expect(prepareStep.run).toContain('case "$test_profile" in');
        expect(prepareStep.run).toContain('normal)');
        expect(prepareStep.run).toContain('negative)');
        expect(prepareStep.run).toContain('all)');
    });

    it('wires integration workflow to normal matrix plus dedicated negative scenario run', () => {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'integration-tests.yml');
        const workflow = loadYaml(workflowPath);

        expect(workflow.jobs.validate.with['utp-test-profile']).toBe('normal');
        expect(workflow.jobs['validate-negative-scenarios']).toBeDefined();
        expect(workflow.jobs['validate-negative-scenarios'].with['utp-test-profile']).toBe('negative');
    });
});
