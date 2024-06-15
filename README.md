## Overview
The basic idea of this tool:

You register a git repo + docker commands to run the service and this tool will make sure they are always running.

## TODO

- Git commit hook + minimal web server on the pi to receive the hook so we dont have to poll at all
- Dashboard

## How a full workflow works

Check that piploy status
> ./piploy -status


## Build self contained
> dotnet publish -c Release --runtime linux-arm64 --self-contained -p:PublishSingleFile=true

Copy over to the pi

> sudo chmod +x ./piploy

> ./piploy

Dont forget to chmod +x ... after copying

## Install dotnet on the pi

TODO: Install dotnet

## Build and start the tool
Publish:
dotnet publish -c Release -o /home/<user>/Piploy

Service:
sudo nano /etc/systemd/system/piploy.service

Content:
[Unit]
Description=Raspberry pi + docker deployment tool

[Service]
WorkingDirectory=/home/<user>/Piploy
ExecStart=/home/<user>/Piploy/piploy service-start
Restart=always
RestartSec=10
SyslogIdentifier=piploy
User=<user>
Environment=ASPNETCORE_ENVIRONMENT=Production

[Install]
WantedBy=multi-user.target

Register daemon:
sudo systemctl daemon-reload
sudo systemctl enable piploy.service

Start daemon:
sudo systemctl start piploy.service

Status of daemon:
sudo systemctl status piploy.service

Note:
When running this way piploy service-stop is more like a restart since the daemon will instantly restart it.
