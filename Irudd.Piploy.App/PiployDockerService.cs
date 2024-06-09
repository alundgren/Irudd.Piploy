using Docker.DotNet;
using Docker.DotNet.Models;
using Microsoft.Extensions.Options;
using System.Formats.Tar;

namespace Irudd.Piploy.App;

public class PiployDockerService(IOptions<PiploySettings> settings, PiployDockerCleanupService cleanup)
{
    public const string Piploy = "piploy";

    /*
     Docker library: 
     https://github.com/dotnet/Docker.DotNet/
     Real usage examples: 
     https://github.com/testcontainers/testcontainers-dotnet/blob/6688b92d217e710a773e87126fc98c78b27de253/src/Testcontainers/Clients/DockerImageOperations.cs#L127-L139
     */

    private PiploySettings Settings => settings.Value;

    public PiployDockerCleanupService Cleanup => cleanup;

    public async Task<(bool WasCreated, string ImageId)> EnsureImageExists(PiploySettings.Application application, GitCommit commit, CancellationToken cancellationToken)
    {
        using var docker = new DockerClientConfiguration().CreateClient();

        var commitVersionTag = GetImageVersionTagCommit(application.Name, commit);

        var existingImage = await GetExistingImageByVersion(docker, commitVersionTag, cancellationToken);

        if (existingImage != null)
            return (false, existingImage.ID);

        //TODO: Check if already correct version

        var (repoRelativeDockerContextDirectory, dockerfilename) = GetDockerfilePathFromSetting(application.DockerfilePath);
        var absoluteRepoDirectory = application.GetRepoDirectory(Settings);
        var absoluteDockerContextDirectory = Path.Combine(absoluteRepoDirectory, repoRelativeDockerContextDirectory);

        var absoluteDockerfilePath = Path.Combine(absoluteDockerContextDirectory, dockerfilename);
        if (!File.Exists(absoluteDockerfilePath))
            throw new Exception($"Dockerfile '{application.DockerfilePath} does not exist. Expected location: '{absoluteDockerfilePath}'");

        using var tarFile = new MemoryStream();
        await TarFile.CreateFromDirectoryAsync(absoluteDockerContextDirectory, tarFile, false, cancellationToken: cancellationToken);
        tarFile.Position = 0;

        var uniqueId = Guid.NewGuid();
        await docker.Images.BuildImageFromDockerfileAsync(new ImageBuildParameters
        {
            Tags = new List<string>
            {
                GetImageVersionTagLatest(application.Name),
                commitVersionTag,
                //This exists to make sure that even if the same git commit is built twice for some reason we always have at least one unique tag per image
                GetImageVersionTagUniqueId(application.Name, uniqueId)
            },
            BuildArgs = new Dictionary<string, string>(), //TODO: Figure out what goes here
            Labels = GetImagesLabels(application, commit, uniqueId),
            Dockerfile = dockerfilename //NOTE: This is just the name since the tarfile we send has the docker context directory as it's root
        },
        tarFile, Array.Empty<AuthConfig>(), new Dictionary<string, string>(),
        new ProgressTracer(), cancellationToken: cancellationToken);

        existingImage = await GetExistingImageByVersion(docker, commitVersionTag, cancellationToken);

        if (existingImage == null)
            throw new Exception($"Failed to create image for {application.Name}");
        
        return (true, existingImage.ID);
    }
    
    private Dictionary<string, string> GetImagesLabels(PiploySettings.Application application, GitCommit commit, Guid uniqueId)
    {
        var labels = new Dictionary<string, string>
        {
            [$"{Piploy}_buildDate"] = DateTimeOffset.UtcNow.ToString("u"),
            [ImageAppLabelName] = application.Name,
            [$"{Piploy}_gitTipCommit"] = commit.Value,
            [$"{Piploy}_uniqueId"] = uniqueId.ToString()
        };
        
        if (Settings.IsTestRun == true)
            labels[TestMarkerLabelName] = "true";

        return labels;
    }

    public async Task<(bool WasCreated, bool WasStarted, string ContainerId)> EnsureContainerRunning(PiploySettings.Application application, GitCommit commit, CancellationToken cancellationToken)
    {
        using var docker = new DockerClientConfiguration().CreateClient();

        var containerName = $"{Piploy}_{application.Name}";

        var existingContainer = await GetExistingContainerByName(docker, containerName, cancellationToken);

        if(existingContainer != null)
        {
            //TODO: Check if already correct version and then just start it
            await docker.Containers.StopContainerAsync(existingContainer.ID, new ContainerStopParameters
            {
                WaitBeforeKillSeconds = 5 //TODO: Configurable per app
            }, cancellationToken);
        }

        var commitImageTag = GetImageVersionTagCommit(application.Name, commit);

        var portBindings = application
            .GetPortMappings()
            .ToDictionary(
                x => $"{x.ContainerPort}/tcp", 
                x => (IList<PortBinding>)new List<PortBinding> { new PortBinding { HostPort = x.HostPort.ToString() } });

        var createContainerParameters = new CreateContainerParameters
        {
            Image = commitImageTag,
            Name = containerName,
            HostConfig = new HostConfig
            {
                PortBindings = portBindings,
                AutoRemove = true
            }
        };

        var response = await docker.Containers.CreateContainerAsync(createContainerParameters, cancellationToken: cancellationToken);
        //TODO: Logg this Output.WriteLine(JsonConvert.SerializeObject(response));
        if (response.ID == null)
            throw new Exception($"Failed to create container for {application.Name}. Image used: {commitImageTag}.");

        try
        {
            bool wasStarted = await docker.Containers.StartContainerAsync(response.ID, new ContainerStartParameters());

            return (true, wasStarted, response.ID);
        }
        catch(DockerApiException ex)
        {
            if (ex.Message.Contains("port is already allocated"))
                throw new Exception("Port is already allocated"); //TODO: Can we figure out by what?
            throw;
        }
    }

    private async Task<ImagesListResponse?> GetExistingImageByVersion(DockerClient docker, string versionTag, CancellationToken cancellationToken) =>
        (await docker.Images.ListImagesAsync(new ImagesListParameters
        {
            Filters = new Dictionary<string, IDictionary<string, bool>>
            {
                { "reference", new Dictionary<string, bool> { { versionTag, true } } }
            }
        }, cancellationToken: cancellationToken)).FirstOrDefault();

    private async Task<ContainerListResponse?> GetExistingContainerByName(DockerClient docker, string containerName, CancellationToken cancellationToken) =>
        (await docker.Containers.ListContainersAsync(new ContainersListParameters
        {
            Filters = new Dictionary<string, IDictionary<string, bool>>
            {
                { "name", new Dictionary<string, bool> { { containerName, true } } }
            }
        }, cancellationToken)).FirstOrDefault();
        
    public static string GetImageVersionTagLatest(string appName) => GetImageVersionTag(appName, "latest");    
    private string GetImageVersionTagCommit(string appName, GitCommit commit) => GetImageVersionTag(appName, $"g_{commit.Value}");
    private string GetImageVersionTagUniqueId(string appName, Guid uniqueId) => GetImageVersionTag(appName, $"v_{uniqueId.ToString()}");
    //NOTE: Docker will throw if the reference is not all lowercase
    private static string GetImageVersionTag(string appName, string versionValue) => $"{Piploy}/{appName}:{versionValue}".ToLowerInvariant();

    public static string ImageAppLabelName => $"{Piploy}_appName";
    public static string TestMarkerLabelName => $"{Piploy}_isCreatedByTest";    

    public static (string ContextDirectory, string Dockerfilename) GetDockerfilePathFromSetting(string dockerPathSetting)
    {
        //Normalize to format <path>/<filename> where path is repeating segments like <name>/
        var d = dockerPathSetting.Replace(@"\", "/").Trim();
        d = d.StartsWith("/") ? d.Substring(1) : d;
        if (d.EndsWith("/"))
            throw new Exception("Invalid DockerfilePath. It must point to a dockerfile relative to the repository root. Examples: 'Dockerfile' or 'SubDirectory/Dockerfile' or Dockerfile.custom'");

        var segments = d.Split('/');
        if (segments.Length == 1)
            return ("", segments[0]);
        else
            return (string.Join("/", segments.Take(segments.Length - 1)), segments.Last());
    }

    private class ProgressTracer : IProgress<JSONMessage>
    {
        public void Report(JSONMessage value) {} //TODO: Log JSonConvert.SerializeObject ... seems to be just one filled out at a time
    }
}
