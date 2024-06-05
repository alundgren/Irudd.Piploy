using Irudd.Piploy.Test.Utilities;
using Xunit.Abstractions;

namespace Irudd.Piploy.Test;

public class DockerTests(ITestOutputHelper output) : TestBase(output)
{  
    [Fact]
    public async Task Foo()
    {
        using var context = SetupTest(preserveTestDirectory: false);
        var (app1Directory, app2Directory) = context.FakeRemote.CreateWithDockerfiles();
    }
}