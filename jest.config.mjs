export default {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    transform: {
        '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.jest.json' }],
    },
    moduleNameMapper: {
        '^@electron/asar$': '<rootDir>/tests/mocks/electron-asar.js'
    },
    testMatch: ['**/?(*.)+(test).ts'],
};
