using Irudd.Piploy.App;
using Microsoft.Extensions.Options;
using Xunit.Abstractions;

namespace Irudd.Piploy.Test;

public class EnsureTests(ITestOutputHelper output)
{
    private class TestContext(PiployService service, FakeGitRepository fakeRemote, PiploySettings settings,
        ITestOutputHelper output,
        string tempTestDirectory,
        bool preserveTestDirectory) : IDisposable
    {
        public PiployService Service => service;
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

    private TestContext SetupTest(bool preserveTestDirectory = false)
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
        var service = new PiployService(Options.Create(settings));

        var remote = new FakeGitRepository(remoteDirectory);
        remote.CreateWithInitialFile();

        return new TestContext(service, remote, settings, output, tempTestDirectory, preserveTestDirectory);
    }

    [Fact]
    public async Task RootDirectoryNotCreated_WhenEnsureCalled_IsCreated()
    {
        using var context = SetupTest();

        await context.Service.EnsureLocalRepositoriesAsync();

        Assert.True(Directory.Exists(context.Settings.RootDirectory), "Root directory was not created");
    }

    [Fact]
    public async Task ApplicationDirectoryNotCreated_WhenEnsureCalled_IsCreated()
    {
        using var context = SetupTest();

        await context.Service.EnsureLocalRepositoriesAsync();

        var expectedApplicationDirectory = Path.Combine(context.Settings.RootDirectory, context.Application.Name);
        Assert.True(Directory.Exists(expectedApplicationDirectory), "Application directory was not created");
    }

    [Fact]
    public async Task ApplicationDirectoryEmpty_WhenEnsureCalled_RemoteIsCloned()
    {
        using var context = SetupTest();

        await context.Service.EnsureLocalRepositoriesAsync();

        var expectedClonedInitialFile = Path.Combine(context.Application.GetRepoDirectory(context.Settings), FakeGitRepository.InitialFilename);
        Assert.True(File.Exists(expectedClonedInitialFile), "Remote was not cloned to the repo directory");
    }

    [Fact]
    public async Task RemoteHasChanges_WhenEnsureCalled_LocalIsMovedForward()
    {
        using var context = SetupTest();
        await context.Service.EnsureLocalRepositoriesAsync();
        context.FakeRemote.AddSecondFile();

        await context.Service.EnsureLocalRepositoriesAsync();

        var expectedClonedSecondFile = Path.Combine(context.Application.GetRepoDirectory(context.Settings), FakeGitRepository.SecondFilename);
        Assert.True(File.Exists(expectedClonedSecondFile), "Changes from the remote where not present locally after ensure");
    }
}