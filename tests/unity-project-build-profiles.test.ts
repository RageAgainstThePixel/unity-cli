import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UnityProject } from '../src/unity-project';

const buildProfile = (name: string, target: number) => `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!114 &11400000
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_Script: {fileID: 15003, guid: 0000000000000000e000000000000000, type: 0}
  m_Name: ${name}
  m_AssetVersion: 1
  m_BuildTarget: ${target}
  m_Subtarget: 0
  m_PlatformId: 84a3bb9e7420477f885e98145999eb20
  m_PlatformBuildProfile:
    rid: 1
  m_OverrideGlobalSceneList: 0
  m_PlayerSettingsYaml:
    m_Settings:
    - line: '|   m_BuildTargetIcons: []'
    - line: '|   - m_BuildTarget: Android'
`;

describe('UnityProject.GetBuildProfileTargets', () => {
    let projectPath: string;

    beforeEach(() => {
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-project-'));
        fs.mkdirSync(path.join(projectPath, 'ProjectSettings'));
        fs.writeFileSync(path.join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.27f1\n');
        fs.mkdirSync(path.join(projectPath, 'Assets', 'Settings', 'Build Profiles'), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(projectPath, { recursive: true, force: true });
    });

    it('returns each saved build profile target once', () => {
        const profiles = path.join(projectPath, 'Assets', 'Settings', 'Build Profiles');
        fs.writeFileSync(path.join(profiles, 'Web.asset'), buildProfile('Web', 20));
        fs.writeFileSync(path.join(profiles, 'Android Dev.asset'), buildProfile('Android Dev', 13));
        fs.writeFileSync(path.join(profiles, 'Android Release.asset'), buildProfile('Android Release', 13).replace(/\n/g, '\r\n'));
        fs.writeFileSync(path.join(projectPath, 'Assets', 'Other.asset'), 'MonoBehaviour:\n  m_BuildTarget: 9\n');

        expect(new UnityProject(projectPath).GetBuildProfileTargets().sort()).toEqual(['Android', 'WebGL']);
    });

    it('returns nothing without build profiles', () => {
        expect(new UnityProject(projectPath).GetBuildProfileTargets()).toEqual([]);
    });
});
