using Irudd.Piploy.App;
using Irudd.Piploy.Test.Utilities;
using Xunit.Abstractions;

namespace Irudd.Piploy.Test;

public class DockerTests(ITestOutputHelper output) : TestBase(output), IAsyncLifetime
{
    [Fact]
    public async Task EnsureImage()
    {
        using var context = SetupTest(preserveTestDirectory: false);
        using var tokenSource = new CancellationTokenSource();
        var (_, _, commit) = context.FakeRemote.CreateWithDockerfiles();
        var app1 = context.App1Application;
        context.Git.EnsureLocalRepository(app1);

        var (wasCreated, _) = await context.Docker.EnsureImageExists(app1, commit, cancellationToken: tokenSource.Token);

        Assert.True(wasCreated);
    }

    [Fact]
    public async Task PortInUsePort()
    {
        using var context = SetupTest(preserveTestDirectory: false);
        var (_, _, commit) = context.FakeRemote.CreateWithDockerfiles();
        using var tokenSource = new CancellationTokenSource();
        context.App2Application.PortMappings = context.App1Application.PortMappings;
        try
        {
            await context.Piploy.Poll(tokenSource.Token);
            Assert.Fail($"Expected PiployException with Code={PiployException.PortAlreadyInUseCode}");
        }
        catch(PiployException ex)
        {
            Assert.Equal(PiployException.PortAlreadyInUseCode, ex.Code);
        }
    }

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

        Output.WriteLine(await context.Piploy.GetStatusText(tokenSource.Token));

        Assert.True(wasCreated);
        Assert.True(wasStarted);

        (wasCreated, wasStarted, containerId) = await context.Docker.EnsureContainerRunning(app1, commit, tokenSource.Token);

        Assert.False(wasCreated);
        Assert.False(wasStarted);
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
    [InlineData(null, "", "Dockerfile")]
    public void DockerPathSetting(string? setting, string expectedContextDirectory, string expectedDockerfilename)
    {
        var (contextDirectory, dockerFilename) = PiployDockerService.GetDockerfilePathFromSetting(setting);

        Assert.Equal(expectedContextDirectory, contextDirectory);
        Assert.Equal(expectedDockerfilename, dockerFilename);
    }

    [Theory]
    [InlineData("FROM node:current-slim@sha256:deae974a69e140f44f434ab29cb519fb5f8fe250fd364b8ca446bd0761acdc6a")]
    [InlineData("FROM docker.io/library/nginx@sha256:5a88c9c45479443d7be2eadc894b4ed0a9801bae03d97a5760ae13b5c2005942")]
    [InlineData("FROM mcr.microsoft.com/dotnet/core/sdk:3.1@sha256:150d074697d1cda38a0c2185fe43895d84b5745841e9d15c5adba29604a6e4cb AS build\nCOPY --from=build /out /out")]
    [InlineData("FROM scratch AS empty\nCOPY --from=empty /out /out")]
    public void DockerfilePolicyAcceptsApprovedImmutableImages(string dockerfile) => ValidateDockerfile(dockerfile);

    [Theory]
    [InlineData("FROM nginx:latest")]
    [InlineData("FROM somebody/nginx@sha256:5a88c9c45479443d7be2eadc894b4ed0a9801bae03d97a5760ae13b5c2005942")]
    [InlineData("FROM ghcr.io/example/image@sha256:5a88c9c45479443d7be2eadc894b4ed0a9801bae03d97a5760ae13b5c2005942")]
    [InlineData("ARG IMAGE=node\nFROM ${IMAGE}@sha256:deae974a69e140f44f434ab29cb519fb5f8fe250fd364b8ca446bd0761acdc6a")]
    [InlineData("FROM scratch\nCOPY --from=nginx:latest /out /out")]
    [InlineData("FROM scratch\nCOPY --from=mcr.microsoft.com/other/image@sha256:150d074697d1cda38a0c2185fe43895d84b5745841e9d15c5adba29604a6e4cb /out /out")]
    public void DockerfilePolicyRejectsMutableUntrustedOrDynamicImages(string dockerfile)
    {
        var exception = Assert.Throws<InvalidOperationException>(() => ValidateDockerfile(dockerfile));
        Assert.Contains("Dockerfile", exception.Message);
    }

    private static void ValidateDockerfile(string contents)
    {
        var path = Path.GetTempFileName();
        try
        {
            File.WriteAllText(path, contents);
            DockerfileImagePolicy.Validate(path);
        }
        finally
        {
            File.Delete(path);
        }
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
        //TODO: We should run it before every test but just once after all the tests so this should be moved to a fixture class
        var docker = new PiployDockerCleanupService();
        using var tokenSource = new CancellationTokenSource();
        tokenSource.CancelAfter(30000);
        await docker.CleanupTestCreated(tokenSource.Token);
    }
}
