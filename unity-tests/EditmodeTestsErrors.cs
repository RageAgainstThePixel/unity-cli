using NUnit.Framework;

namespace UnityCli.UtpSamples
{
    /// <summary>
    /// Editmode test that intentionally fails to produce real test failure output.
    /// </summary>
    public class EditmodeTestsErrors
    {
        [Test]
        public void FailsEditmodeSuite()
        {
            Assert.Fail("Intentional editmode failure for test matrix coverage.");
        }
    }
}
