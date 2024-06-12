using Irudd.Piploy.Test.Utilities;
using Xunit.Abstractions;

namespace Irudd.Piploy.Test;

/*
 Fake remote structure:
 app1/
     index.html
     Dockerfile
     hello.conf
 app2/
     index.html
     Dockerfile
     hello.conf
 */
public class GitTests(ITestOutputHelper output) : TestBase(output)
{ 
    [Fact]
    public void RootDirectoryNotCreated_WhenEnsureCalled_IsCreated()
    {
        using var context = SetupTest();
        context.FakeRemote.CreateWithDockerfiles();

        context.Git.EnsureLocalRepositories();

        Assert.True(Directory.Exists(context.Settings.RootDirectory), "Root directory was not created");
    }

    [Fact]
    public void ApplicationDirectoryNotCreated_WhenEnsureCalled_IsCreated()
    {
        using var context = SetupTest();
        context.FakeRemote.CreateWithDockerfiles();

        context.Git.EnsureLocalRepositories();

        var expectedApplicationDirectory = Path.Combine(context.Settings.RootDirectory, context.App1Application.Name);
        Assert.True(Directory.Exists(expectedApplicationDirectory), "Application directory was not created");
    }

    [Fact]
    public void ApplicationDirectoryEmpty_WhenEnsureCalled_RemoteIsCloned()
    {
        using var context = SetupTest();
        context.FakeRemote.CreateWithDockerfiles();
        var app = context.App1Application;

        context.Git.EnsureLocalRepository(app);

        var expectedClonedInitialFile = Path.Combine(app.GetRepoDirectory(context.Settings), $"{app.Name}/{FakeGitRepository.IndexFilename}");
        Assert.True(File.Exists(expectedClonedInitialFile), "Remote was not cloned to the repo directory");
    }

    [Fact]
    public void RemoteHasChanges_WhenEnsureCalled_LocalIsMovedForward()
    {
        const string TestTag = "a6070008-cc23-453a-a93d-b28c4cc73e78";
        using var context = SetupTest(preserveTestDirectory: true);
        context.FakeRemote.CreateWithDockerfiles();
        var app = context.App1Application;
        context.Git.EnsureLocalRepository(app);
        context.FakeRemote.UpdateIndexHtmlFile(app.Name, testTag: TestTag);
        
        context.Git.EnsureLocalRepository(app);

        var filePath = Path.Combine(app.GetRepoDirectory(context.Settings), $"{app.Name}/{FakeGitRepository.IndexFilename}");
        Assert.Contains(TestTag, File.ReadAllText(filePath));
    }
}