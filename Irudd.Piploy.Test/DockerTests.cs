using Irudd.Piploy.App;
using Irudd.Piploy.Test.Utilities;
using Xunit.Abstractions;

namespace Irudd.Piploy.Test;

public class DockerTests(ITestOutputHelper output) : TestBase(output), IAsyncLifetime
{
    [Fact]
    public async Task EnsureImage()
    {
        //TODO: How to reset docker state before tests or at least ensure we dont just blow it up with infinite test containers/images
        using var context = SetupTest(preserveTestDirectory: false);
        using var tokenSource = new CancellationTokenSource();
        var (_, _, commit) = context.FakeRemote.CreateWithDockerfiles();
        var app1 = context.App1Application;
        context.Git.EnsureLocalRepository(app1);

        var (wasCreated, _) = await context.Docker.EnsureImageExists(app1, commit, cancellationToken: tokenSource.Token);

        Assert.True(wasCreated);
    }

    /*
     Setup a test for this:
        Docker.DotNet.DockerApiException : Docker API responded with status code=InternalServerError, response={"message":"driver failed programming external connectivity on endpoint piploy_app1 (1e71afd3f4aee172869dc552eff8121404ed64c93f008a1ef54d6ad017d19d1f): Bind for 0.0.0.0:8084 failed: port is already allocated"}
        And make sure we log it so we understand that this is what happened
     */

    [Fact]
    public async Task EnsureRunningContainer()
    {
        using var context = SetupTest(preserveTestDirectory: false);
        using var tokenSource = new CancellationTokenSource();
        var (_, _, commit) = context.FakeRemote.CreateWithDockerfiles();
        var app1 = context.App1Application;
        context.Git.EnsureLocalRepository(app1);
        await context.Docker.EnsureImageExists(app1, commit, cancellationToken: tokenSource.Token);

        var (wasCreated, wasStarted, containerId) = await context.Docker.EnsureContainerRunning(app1, commit, tokenSource.Token);

        Assert.True(wasCreated);
        Assert.True(wasStarted);
    }

    [Theory]
    [InlineData("Dockerfile", "", "Dockerfile")]
    [InlineData("/Dockerfile", "", "Dockerfile")]
    [InlineData(@"\Dockerfile", "", "Dockerfile")]
    [InlineData(@"Api/Dockerfile", "Api", "Dockerfile")]
    [InlineData(@"Api/Dockerfile.api", "Api", "Dockerfile.api")]
    [InlineData(@"Dockerfile.api", "", "Dockerfile.api")]
    [InlineData(@"/Dockerfile.api", "", "Dockerfile.api")]
    [InlineData(@"a b/c d/file name", "a b/c d", "file name")]
    [InlineData(@"/a b/c d/file name", "a b/c d", "file name")]
    [InlineData(@"/a b/c d\file name", "a b/c d", "file name")]
    public void DockerPathSetting(string setting, string expectedContextDirectory, string expectedDockerfilename)
    {
        var (contextDirectory, dockerFilename) = PiployDockerService.GetDockerfilePathFromSetting(setting);

        Assert.Equal(expectedContextDirectory, contextDirectory);
        Assert.Equal(expectedDockerfilename, dockerFilename);
    }

    public async Task InitializeAsync()
    {
        var docker = new PiployDockerCleanupService();
        using var tokenSource = new CancellationTokenSource();
        tokenSource.CancelAfter(30000);
        await docker.CleanupTestCreated(tokenSource.Token);
    }

    public async Task DisposeAsync()
    {
        /*
        //TODO: We should run it before every test but just once after all the tests so this should be moved to a fixture class
        var docker = new PiployDockerCleanupService();
        using var tokenSource = new CancellationTokenSource();
        tokenSource.CancelAfter(30000);
        await docker.CleanupTestCreated(tokenSource.Token);
        */
    }
}