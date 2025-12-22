using System.Collections;
using NUnit.Framework;
using UnityEngine.TestTools;

namespace UnityCli.UtpSamples
{
    /// <summary>
    /// Playmode test that intentionally fails to generate real test failure output.
    /// </summary>
    public class PlaymodeTestsErrors
    {
        [UnityTest]
        public IEnumerator FailsPlaymodeSuite()
        {
            yield return null;
            Assert.Fail("Intentional playmode failure for test matrix coverage.");
        }
    }
}
