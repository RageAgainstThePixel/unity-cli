using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;

namespace UnityCli.UtpSamples
{
    /// <summary>
    /// Emits a build-time warning via the build pipeline (no custom UTP JSON logging).
    /// Place under an Editor folder when copying into a project.
    /// </summary>
    public class BuildWarnings : IPreprocessBuildWithReport
    {
        public int callbackOrder => 0;

        public void OnPreprocessBuild(BuildReport report)
        {
            UnityEngine.Debug.LogWarning("Intentional build warning.");
        }
    }
}
