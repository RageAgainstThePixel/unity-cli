using System.Collections;
using UnityEngine;
using NUnit.Framework;
using UnityEngine.TestTools;

namespace UnityCli.UtpSamples
{
    /// <summary>
    /// Playmode test that passes for test matrix and summary table coverage.
    /// </summary>
    public class PlaymodeTestsPassing
    {
        [UnityTest]
        public IEnumerator PassesPlaymodeSuite()
        {
            yield return null;
            Assert.Pass("Intentional playmode pass");
        }
    }
}
