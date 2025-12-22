using UnityEngine;

namespace UnityCli.UtpSamples
{
    /// <summary>
    /// Introduces a benign compiler warning (unused variable) without emitting custom logs.
    /// </summary>
    public class CompilerWarnings : MonoBehaviour
    {
        private void Awake()
        {
            ObsoleteApi(); // CS0618: call to obsolete member
        }

        [System.Obsolete("Intentional warning for test matrix coverage", false)]
        private static void ObsoleteApi()
        {
        }
    }
}
