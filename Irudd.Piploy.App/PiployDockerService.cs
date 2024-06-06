using Docker.DotNet;
using Docker.DotNet.Models;
using Microsoft.Extensions.Options;
using System.Formats.Tar;

namespace Irudd.Piploy.App;

public class PiployDockerService(IOptions<PiploySettings> settings)
{
    const string Piploy = "piploy";

    /*
     Docker library: 
     https://github.com/dotnet/Docker.DotNet/
     Real usage examples: 
     https://github.com/testcontainers/testcontainers-dotnet/blob/6688b92d217e710a773e87126fc98c78b27de253/src/Testcontainers/Clients/DockerImageOperations.cs#L127-L139
     */

    private PiploySettings Settings => settings.Value;

    public async Task<(bool WasCreated, string ImageId)> EnsureImageExists(PiploySettings.Application application, GitCommit commit, CancellationToken cancellationToken)
    {
        using var docker = new DockerClientConfiguration().CreateClient();

        var versionTag = GetImageVersionTag(application.Name, commit.Value);

        var existingImage = await GetExistingImage(docker, versionTag, cancellationToken);

        if (existingImage != null)
            return (false, existingImage.ID);

        var (repoRelativeDockerContextDirectory, dockerfilename) = GetDockerfilePathFromSetting(application.DockerfilePath);
        var absoluteRepoDirectory = application.GetRepoDirectory(Settings);
        var absoluteDockerContextDirectory = Path.Combine(absoluteRepoDirectory, repoRelativeDockerContextDirectory);

        var absoluteDockerfilePath = Path.Combine(absoluteDockerContextDirectory, dockerfilename);
        if (!File.Exists(absoluteDockerfilePath))
            throw new Exception($"Dockerfile '{application.DockerfilePath} does not exist. Expected location: '{absoluteDockerfilePath}'");

        using var tarFile = new MemoryStream();
        await TarFile.CreateFromDirectoryAsync(absoluteDockerContextDirectory, tarFile, false, cancellationToken: cancellationToken);
        tarFile.Position = 0;

        await docker.Images.BuildImageFromDockerfileAsync(new ImageBuildParameters
        {
            Tags = new List<string>
            {
                GetImageVersionTag(application.Name, "latest"),
                versionTag,
            },
            BuildArgs = new Dictionary<string, string>(), //TODO: Figure out what goes here
            Labels = new Dictionary<string, string>
            {
                [$"{Piploy}_buildDate"] = DateTimeOffset.UtcNow.ToString("u"),
                [$"{Piploy}_appName"] = application.Name,
                [$"{Piploy}_gitTipCommit"] = commit.Value
            },
            Dockerfile = dockerfilename //NOTE: This is just the name since the tarfile we send has the docker context directory as it's root
        },
        tarFile, Array.Empty<AuthConfig>(), new Dictionary<string, string>(),
        new ProgressTracer(), cancellationToken: cancellationToken);

        existingImage = await GetExistingImage(docker, versionTag, cancellationToken);

        if (existingImage == null)
            throw new Exception($"Failed to create image for {application.Name}");
        
        return (true, existingImage.ID);
    }

    private async Task<ImagesListResponse?> GetExistingImage(DockerClient docker, string versionTag, CancellationToken cancellationToken) =>
        (await docker.Images.ListImagesAsync(new ImagesListParameters
        {
            Filters = new Dictionary<string, IDictionary<string, bool>>
            {
                { "reference", new Dictionary<string, bool> { { versionTag, true } } }
            }
        }, cancellationToken: cancellationToken)).FirstOrDefault();

    //NOTE: Docker will throw if the reference is not all lowercase
    private string GetImageVersionTag(string appName, string versionValue) => $"{Piploy}/{appName}:{versionValue}".ToLowerInvariant();

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
    /*
    public async Task EnsureContainerExistsAndIsRunning(PiploySettings.Application application, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }

    public async Task PruneUnusedImages(PiploySettings.Application application, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }
    */
}
