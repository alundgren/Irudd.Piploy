using Irudd.Piploy.Test.Utilities;
using Xunit.Abstractions;

namespace Irudd.Piploy.Test;

public class GitTests(ITestOutputHelper output) : TestBase(output)
{ 
    [Fact]
    public async Task RootDirectoryNotCreated_WhenEnsureCalled_IsCreated()
    {
        using var context = SetupTest();
        context.FakeRemote.CreateWithInitialFile();

        await context.Git.EnsureLocalRepositoriesAsync();

        Assert.True(Directory.Exists(context.Settings.RootDirectory), "Root directory was not created");
    }

    [Fact]
    public async Task ApplicationDirectoryNotCreated_WhenEnsureCalled_IsCreated()
    {
        using var context = SetupTest();
        context.FakeRemote.CreateWithInitialFile();

        await context.Git.EnsureLocalRepositoriesAsync();

        var expectedApplicationDirectory = Path.Combine(context.Settings.RootDirectory, context.Application.Name);
        Assert.True(Directory.Exists(expectedApplicationDirectory), "Application directory was not created");
    }

    [Fact]
    public async Task ApplicationDirectoryEmpty_WhenEnsureCalled_RemoteIsCloned()
    {
        using var context = SetupTest();
        context.FakeRemote.CreateWithInitialFile();

        await context.Git.EnsureLocalRepositoriesAsync();

        var expectedClonedInitialFile = Path.Combine(context.Application.GetRepoDirectory(context.Settings), FakeGitRepository.InitialFilename);
        Assert.True(File.Exists(expectedClonedInitialFile), "Remote was not cloned to the repo directory");
    }

    [Fact]
    public async Task RemoteHasChanges_WhenEnsureCalled_LocalIsMovedForward()
    {
        using var context = SetupTest();
        context.FakeRemote.CreateWithInitialFile();
        await context.Git.EnsureLocalRepositoriesAsync();
        context.FakeRemote.AddSecondFile();

        await context.Git.EnsureLocalRepositoriesAsync();

        var expectedClonedSecondFile = Path.Combine(context.Application.GetRepoDirectory(context.Settings), FakeGitRepository.SecondFilename);
        Assert.True(File.Exists(expectedClonedSecondFile), "Changes from the remote where not present locally after ensure");
    }
}