using Docker.DotNet;
using Docker.DotNet.Models;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Newtonsoft.Json;
using System.Formats.Tar;

namespace Irudd.Piploy.App;

public class PiployDockerService(IOptions<PiploySettings> settings, PiployDockerCleanupService cleanup, ILogger<PiployDockerService> logger)
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

        logger.LogInformation($"Building docker image for commit {commit.Hash}");

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
        new ProgressTracer(logger), cancellationToken: cancellationToken);

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
            [ImageCommitLabelName] = commit.Hash,
            [$"{Piploy}_uniqueId"] = uniqueId.ToString()
        };
        
        if (Settings.IsTestRun == true)
            labels[TestMarkerLabelName] = "true";

        return labels;
    }

    public async Task<(bool WasCreated, bool WasStarted, string ContainerId)> EnsureContainerRunning(PiploySettings.Application application, GitCommit commit, CancellationToken cancellationToken)
    {
        using var docker = new DockerClientConfiguration().CreateClient();

        var containerName = GetContainerName(application);

        var existingContainer = await GetExistingContainerByName(docker, containerName, cancellationToken);

        if(existingContainer != null)
        {
            if(existingContainer.Labels != null && existingContainer.Labels.Any(x => x.Key == $"{Piploy}_gitTipCommit" && x.Value == commit.Hash))
            {                
                if(existingContainer.State == "exited" || existingContainer.State == "running")
                {
                    logger.LogInformation($"Container exists with the correct version already in state = {existingContainer.State}.");
                    var wasStarted = false;
                    if(existingContainer.State == "exited")
                    {
                        logger.LogInformation($"Starting container {containerName}");
                        wasStarted = await docker.Containers.StartContainerAsync(existingContainer.ID, new ContainerStartParameters());
                    }
                    return (false, wasStarted, existingContainer.ID);
                }
                else
                {
                    logger.LogInformation($"Container exists with the correct version already. Current state = {existingContainer.State} is bad. Will be rebuilt.");
                }
            }

            logger.LogInformation($"Removing container {containerName}");
            await docker.Containers.RemoveContainerAsync(existingContainer.ID, new ContainerRemoveParameters { Force = true }, cancellationToken);
        }

        var commitImageTag = GetImageVersionTagCommit(application.Name, commit);

        var portMappings = application.GetPortMappings();
        var portBindings = portMappings
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
            },
            ExposedPorts = portMappings.ToDictionary(x => $"{x.ContainerPort}/tcp", _ => new EmptyStruct())
        };

        logger.LogInformation($"Creating container {containerName}");
        var response = await docker.Containers.CreateContainerAsync(createContainerParameters, cancellationToken: cancellationToken);
        logger.LogInformation(JsonConvert.SerializeObject(response));
        if (response.ID == null)
            throw new Exception($"Failed to create container for {application.Name}. Image used: {commitImageTag}.");

        try
        {
            logger.LogInformation($"Starting container {containerName}");
            bool wasStarted = await docker.Containers.StartContainerAsync(response.ID, new ContainerStartParameters());

            return (true, wasStarted, response.ID);
        }
        catch(DockerApiException ex)
        {            
            if (ex.Message.Contains("port is already allocated"))
                throw PiployException.CreatePortAlreadyInUse(portMappings?.Select(x => x.HostPort));

            throw;
        }
    }

    public async Task<(string? LatestImageHash, string? RunningContainerHash)> GetDockerStatus(PiploySettings.Application application, CancellationToken cancellationToken)
    {
        using var docker = new DockerClientConfiguration().CreateClient();

        var image = await GetExistingImageByVersion(docker, GetImageVersionTagLatest(application.Name), cancellationToken);
        var container = await GetExistingContainerByName(docker, GetContainerName(application), cancellationToken);
        
        return (
            image?.Labels[ImageCommitLabelName],
            container?.State == "running" ? container?.Labels[ImageCommitLabelName] : null);
    }

    private async Task<ImagesListResponse?> GetExistingImageByVersion(DockerClient docker, string versionTag, CancellationToken cancellationToken) =>
        (await docker.Images.ListImagesAsync(new ImagesListParameters
        {
            Filters = new Dictionary<string, IDictionary<string, bool>>
            {
                { "reference", new Dictionary<string, bool> { { versionTag, true } } }
            }
        }, cancellationToken: cancellationToken)).FirstOrDefault();

    private string GetContainerName(PiploySettings.Application application) => $"{Piploy}_{application.Name}";
        
    private async Task<ContainerListResponse?> GetExistingContainerByName(DockerClient docker, string containerName, CancellationToken cancellationToken) =>
        (await docker.Containers.ListContainersAsync(new ContainersListParameters
        {
            Filters = new Dictionary<string, IDictionary<string, bool>>
            {
                { "name", new Dictionary<string, bool> { { containerName, true } } }
            }
        }, cancellationToken)).FirstOrDefault();
        
    public static string GetImageVersionTagLatest(string appName) => GetImageVersionTag(appName, "latest");    
    private string GetImageVersionTagCommit(string appName, GitCommit commit) => GetImageVersionTag(appName, $"g_{commit.Hash}");
    private string GetImageVersionTagUniqueId(string appName, Guid uniqueId) => GetImageVersionTag(appName, $"v_{uniqueId.ToString()}");
    //NOTE: Docker will throw if the reference is not all lowercase
    private static string GetImageVersionTag(string appName, string versionValue) => $"{Piploy}/{appName}:{versionValue}".ToLowerInvariant();

    public static string ImageAppLabelName => $"{Piploy}_appName";
    public static string TestMarkerLabelName => $"{Piploy}_isCreatedByTest";
    public static string ImageCommitLabelName => $"{Piploy}_gitTipCommit";

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

    private class ProgressTracer(ILogger<PiployDockerService> logger) : IProgress<JSONMessage>
    {
        public void Report(JSONMessage value) => logger.LogInformation(JsonConvert.SerializeObject(value));
    }
}
