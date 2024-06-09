using Irudd.Piploy.App;
using Microsoft.Extensions.Options;
using Xunit.Abstractions;

namespace Irudd.Piploy.Test.Utilities;

public abstract class TestBase(ITestOutputHelper output)
{
    protected ITestOutputHelper Output => output;

    protected class TestContext(FakeGitRepository fakeRemote, PiploySettings settings,
      ITestOutputHelper output,
      string tempTestDirectory,
      bool preserveTestDirectory) : IDisposable
    {
        public PiployGitService Git { get; } = new PiployGitService(Options.Create(settings));
        public PiployDockerService Docker { get; } = new PiployDockerService(Options.Create(settings), new PiployDockerCleanupService());
        public FakeGitRepository FakeRemote => fakeRemote;
        public PiploySettings Settings => settings;

        public PiploySettings.Application App1Application => settings.Applications[0];
        public PiploySettings.Application App2Application => settings.Applications[1];

        public void Dispose()
        {
            if (preserveTestDirectory)
                output.WriteLine($"Test directory: {tempTestDirectory}");
            else
            {
                //git sets everything readonly so we need to remove that to get rid of the test data
                foreach (var directory in new DirectoryInfo(tempTestDirectory).GetFileSystemInfos("*", SearchOption.AllDirectories))
                    File.SetAttributes(directory.FullName, FileAttributes.Normal);
                Directory.Delete(tempTestDirectory, true);
            }
        }
    }

    protected TestContext SetupTest(bool preserveTestDirectory = false)
    {
        var tempTestDirectory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString());
        var applicationRootDirectory = Path.Combine(tempTestDirectory, "root");
        var remoteDirectory =  Path.Combine(tempTestDirectory, "remote");
        Directory.CreateDirectory(tempTestDirectory);

        var settings = new PiploySettings
        {
            Applications = new List<PiploySettings.Application> 
            {
                new PiploySettings.Application
                {
                    GitRepositoryUrl = remoteDirectory,
                    Name = "app1",
                    DockerfilePath = "app1/Dockerfile",
                    PortMappings = new List<string> { "8085:80" }
                },
                new PiploySettings.Application
                {
                    GitRepositoryUrl = remoteDirectory,
                    Name = "app2",
                    DockerfilePath = "app2/Dockerfile",
                    PortMappings = new List<string> { "8086:80" }
                }
            },
            RootDirectory = applicationRootDirectory,
            IsTestRun = true
        };

        var remote = new FakeGitRepository(remoteDirectory);

        return new TestContext(remote, settings, output, tempTestDirectory, preserveTestDirectory);
    }
}
