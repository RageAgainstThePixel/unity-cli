type LoggingModule = typeof import('../src/logging');

describe('Logger annotate', () => {
    const ORIGINAL_ENV = process.env;

    const loadLoggingModule = (): LoggingModule => {
        return require('../src/logging') as LoggingModule;
    };

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...ORIGINAL_ENV };
    });

    afterEach(() => {
        process.env = ORIGINAL_ENV;
        jest.restoreAllMocks();
    });

    it('formats annotations correctly for GitHub Actions', () => {
        process.env.GITHUB_ACTIONS = 'true';
        const logging = loadLoggingModule();
        const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

        logging.Logger.instance.annotate(
            logging.LogLevel.ERROR,
            'Line one\nLine two',
            'src/file.ts',
            7,
            undefined,
            undefined,
            undefined,
            'Build failed'
        );

        expect(writeSpy).toHaveBeenCalledWith('::error file=src/file.ts,line=7,title=Build failed::Line one%0ALine two\n');
    });

    it('omits metadata spacing when none is provided', () => {
        process.env.GITHUB_ACTIONS = 'true';
        const logging = loadLoggingModule();
        const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

        logging.Logger.instance.annotate(logging.LogLevel.INFO, 'Hello world');

        expect(writeSpy).toHaveBeenCalledWith('::notice::Hello world\n');
    });

    it('falls back to standard logging when annotations are unavailable', () => {
        delete process.env.GITHUB_ACTIONS;
        const logging = loadLoggingModule();
        const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

        logging.Logger.instance.annotate(logging.LogLevel.INFO, 'Hello local');

        expect(writeSpy).toHaveBeenCalledWith('Hello local\n');
    });
});
