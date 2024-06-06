using Irudd.Piploy.App;
using Microsoft.Extensions.Options;
using Xunit.Abstractions;

namespace Irudd.Piploy.Test.Utilities;

public abstract class TestBase(ITestOutputHelper output)
{
    protected ITestOutputHelper Output => output;

    protected class TestContext(PiployGitService service, FakeGitRepository fakeRemote, PiploySettings settings,
      ITestOutputHelper output,
      string tempTestDirectory,
      bool preserveTestDirectory) : IDisposable
    {
        public PiployGitService Service => service;
        public FakeGitRepository FakeRemote => fakeRemote;
        public PiploySettings Settings => settings;

        public PiploySettings.Application Application => settings.Applications.First();

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
        var remoteDirectory = Path.Combine(tempTestDirectory, "remote");
        Directory.CreateDirectory(tempTestDirectory);

        var application = new PiploySettings.Application
        {
            GitRepositoryUrl = remoteDirectory,
            Name = "testApplication"
        };
        var settings = new PiploySettings
        {
            Applications = new List<PiploySettings.Application> { application },
            RootDirectory = applicationRootDirectory
        };
        var service = new PiployGitService(Options.Create(settings));

        var remote = new FakeGitRepository(remoteDirectory);

        return new TestContext(service, remote, settings, output, tempTestDirectory, preserveTestDirectory);
    }
}
