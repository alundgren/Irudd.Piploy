using Irudd.Piploy.App;
using Microsoft.Extensions.Options;
using Xunit.Abstractions;

namespace Irudd.Piploy.Test;

public class UnitTest1(ITestOutputHelper output)
{
    private class TestContext(PiployService service, FakeGitRepository fakeRemote, PiploySettings settings,
        ITestOutputHelper output,
        string tempTestDirectory,
        bool preserveTestDirectory) : IDisposable
    {
        public PiployService Service => service;
        public FakeGitRepository FakeRemote => fakeRemote;
        public PiploySettings Settings => settings;

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

        var settings = new PiploySettings
        {
            Applications = new List<PiploySettings.Application>(),
            RootFolder = applicationRootDirectory
        };
        var service = new PiployService(Options.Create(settings));

        var remote = new FakeGitRepository(remoteDirectory);

        return new TestContext(service, remote, settings, output, tempTestDirectory, preserveTestDirectory);
    }

    [Fact]
    public async Task ApplicationRootDirectoryNotCreated_WhenEnsureCalled_IsCreated()
    {
        using var context = SetupTest();

        await context.Service.EnsureLocalRepositoriesAsync();

        Assert.True(Directory.Exists(context.Settings.RootFolder), "Application root was not created");
    }

    [Fact]
    public async Task LocalRepoMissing_WhenEnsureCalled_IsCloned()
    {
        using var context = SetupTest(preserveTestDirectory: true);

        context.FakeRemote.CreateWithInitialFile();

        await context.Service.EnsureLocalRepositoriesAsync();

        var expectedIntialFilePath = Path.Combine(Path.Combine(context.Settings.RootFolder, "repo"), FakeGitRepository.InitialFilename);

        Assert.True(File.Exists(expectedIntialFilePath), "Remote was not cloned when local missing");
    }
}