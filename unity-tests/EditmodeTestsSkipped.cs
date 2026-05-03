using NUnit.Framework;

namespace UnityCli.UtpSamples
{
    /// <summary>
    /// Editmode test that is skipped for test matrix and summary table coverage.
    /// </summary>
    public class EditmodeTestsSkipped
    {
        [Test]
        [Ignore("Intentional editmode skip")]
        public void SkippedEditmodeSuite()
        {
            Assert.Fail("Should not run");
        }
    }
}
