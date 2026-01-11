using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;

namespace UnityCli.UtpSamples
{
    /// <summary>
    /// Forces the build pipeline to fail by throwing a BuildFailedException.
    /// Place under an Editor folder when copying into a project.
    /// </summary>
    public class BuildErrors : IPreprocessBuildWithReport
    {
        public int callbackOrder => 0;

        public void OnPreprocessBuild(BuildReport report)
        {
            throw new System.Exception("Intentional build failure.");
        }
    }
}
