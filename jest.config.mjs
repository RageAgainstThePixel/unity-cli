export default {
    extensionsToTreatAsEsm: ['.ts', '.tsx', '.mts'],
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    transform: {
        '^.+\\.m?tsx?$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.jest.json' }],
    },
    moduleNameMapper: {
        '^@electron/asar$': '<rootDir>/tests/mocks/electron-asar.js',
    },
    testMatch: ['**/?(*.)+(test).ts'],
};
