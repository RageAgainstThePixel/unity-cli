using NUnit.Framework;

namespace UnityCli.UtpSamples
{
    /// <summary>
    /// Editmode test that passes for test matrix and summary table coverage.
    /// </summary>
    public class EditmodeTestsPassing
    {
        [Test]
        public void PassesEditmodeSuite()
        {
            Assert.Pass("Intentional editmode pass");
        }
    }
}
