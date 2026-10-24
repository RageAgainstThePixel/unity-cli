export default {
    extensionsToTreatAsEsm: ['.ts', '.tsx', '.mts'],
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    transform: {
        '^.+\\.m?tsx?$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.jest.json' }],
    },
    testMatch: ['**/?(*.)+(test).ts'],
};
