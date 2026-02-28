using System.Collections;
using UnityEngine;
using NUnit.Framework;
using UnityEngine.TestTools;

namespace UnityCli.UtpSamples
{
    /// <summary>
    /// Playmode test that is skipped for test matrix and summary table coverage.
    /// </summary>
    public class PlaymodeTestsSkipped
    {
        [UnityTest]
        [Ignore("Intentional playmode skip")]
        public IEnumerator SkippedPlaymodeSuite()
        {
            yield return null;
            Assert.Fail("Should not run");
        }
    }
}
