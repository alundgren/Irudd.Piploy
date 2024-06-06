using Docker.DotNet;
using Docker.DotNet.Models;
using Irudd.Piploy.Test.Utilities;
using Newtonsoft.Json;
using System.Formats.Tar;
using Xunit.Abstractions;

namespace Irudd.Piploy.Test;

public class DockerTests(ITestOutputHelper output) : TestBase(output)
{  
    [Fact]
    public async Task BuildImage()
    {
        /*
        //https://github.com/dotnet/Docker.DotNet
        using var context = SetupTest(preserveTestDirectory: true);
        var (app1Directory, app2Directory) = context.FakeRemote.CreateWithDockerfiles();

        using var docker = new DockerClientConfiguration().CreateClient();
        using var token = new CancellationTokenSource();
        using var app1Dockerfile = File.OpenRead(Path.Combine(app1Directory, "Dockerfile"));
        */
        //Check if image exists by tag for commit tip

        //If image with same tag exists and stopped: Start
        //If image with same tag exists and started: Do nothing
        //If image exists with different tag exists: Stop and delete image and container then proceed as if no image exists
        //If image does not exist: Build image + start container

        //TODO: Prune or whatever is the best way to make sure docker doesnt eat up all diskspace over time
        //It appears the docker cli creates a tar ball of the docker file + content so this is what should be content
        /*
         https://github.com/dotnet/Docker.DotNet/issues/309#issuecomment-547316442

        Some usage examples here:
        https://github.com/testcontainers/testcontainers-dotnet/blob/6688b92d217e710a773e87126fc98c78b27de253/src/Testcontainers/Clients/DockerImageOperations.cs#L127-L139

        TODO: What about .dockerignore ... is that used for the tarball or after that ... do we need to do that now?
         */
        //await docker.Images.BuildImageFromDockerfileAsync(new Docker.DotNet.Models.ImageBuildParameters { }, app1Dockerfile);

        using var docker = new DockerClientConfiguration().CreateClient();
        using var token = new CancellationTokenSource();
        //using var tarFile = File.OpenRead(@"C:\Users\andre\AppData\Local\Temp\1032d905-988a-4c77-b51b-b73818c7f1d7\remote\app1\app1.tar");

        using var tarFile = new MemoryStream();
        await TarFile.CreateFromDirectoryAsync(@"C:\Users\andre\AppData\Local\Temp\1032d905-988a-4c77-b51b-b73818c7f1d7\remote\app1", tarFile, false, cancellationToken: token.Token);
        tarFile.Position = 0;

        var commit = "3e4634b4958b63603528d5771dddb1bf143add00"; //4d80725d00d206b19668f702549352af0f662734
        var versionTag = $"piploy/app1:{commit}";

        var existingImages = await docker.Images.ListImagesAsync(new ImagesListParameters
        {
            Filters = new Dictionary<string, IDictionary<string, bool>>
            {
                { "reference", new Dictionary<string, bool> { { versionTag, true } } }
            }
        });
        if(existingImages.Any())
        {
            Output.WriteLine("Image already exists");
            return;
        }

        await docker.Images.BuildImageFromDockerfileAsync(new ImageBuildParameters
        {
            Tags = new List<string>
            {
                "piploy/app1:latest",
                versionTag,
            },
            BuildArgs = new Dictionary<string, string>(), //TODO: Figure out what goes here
            Labels = new Dictionary<string, string>
            {
                ["piploy_buildDate"] = DateTimeOffset.UtcNow.ToString("u"),
                ["piploy_appName"] = "app1",
                ["piploy_gitTipCommit"] = "sadff324324"
            }, //Label vs tag?
            Dockerfile = null //TODO: See if we can use this to rename or move the docker file
        },
        tarFile, Array.Empty<AuthConfig>(), new Dictionary<string, string>(), 
        new ProgressTracer(Output), cancellationToken: token.Token);
    }

    [Fact]
    public async Task CreateContainer()
    {
        using var docker = new DockerClientConfiguration().CreateClient();

        var containerName = "piploy_app1";

        var createContainerParameters = new CreateContainerParameters
        {
            Image = "piploy/app1:3e4634b4958b63603528d5771dddb1bf143add00",
            Name = containerName,
            HostConfig = new HostConfig
            {
                PortBindings = new Dictionary<string, IList<PortBinding>>
                {
                    { "80/tcp", new List<PortBinding> { new PortBinding { HostPort = "8084" } } }
                },
                AutoRemove = true
            }
        };
        using var token = new CancellationTokenSource();

        var existingContainers = await docker.Containers.ListContainersAsync(new ContainersListParameters
            {
                Filters = new Dictionary<string, IDictionary<string, bool>>
                {
                    { "name", new Dictionary<string, bool> { { containerName, true } } }
                }
            });

        foreach(var existingContainer in existingContainers)
        {
            //Lets just ignore state for now and always stop
            await docker.Containers.StopContainerAsync(
                existingContainer.ID,
                new ContainerStopParameters
                {
                    WaitBeforeKillSeconds = 5 //TODO: Configurable per app
                },
                token.Token);
        }

        var response = await docker.Containers.CreateContainerAsync(createContainerParameters, cancellationToken: token.Token);
        Output.WriteLine(JsonConvert.SerializeObject(response));
        if (response.ID == null)
        {
            Output.WriteLine("Failed to create");
            return;
        }

        bool started = await docker.Containers.StartContainerAsync(response.ID, new ContainerStartParameters());

        //TODO: Remove all images with label piploy_appName = <appName> not tagged with piploy/<appname>:latest

        Output.WriteLine("State: " + (started ? "Ok" : "Not started"));
    }

    private class ProgressTracer(ITestOutputHelper output) : IProgress<JSONMessage>
    {
        public void Report(JSONMessage value)
        {            
            output.WriteLine(JsonConvert.SerializeObject(value));
        }
    }
}