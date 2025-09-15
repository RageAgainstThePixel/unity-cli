export default {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    transform: {
        '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.jest.json' }],
    },
    testMatch: ['**/?(*.)+(test).ts'],
    // Removed deprecated globals config
};
