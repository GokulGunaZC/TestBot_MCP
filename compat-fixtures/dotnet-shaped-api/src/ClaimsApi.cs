using Microsoft.AspNetCore.Mvc;

namespace Healix.Compat.Dotnet;

[ApiController]
[Route("api/claims")]
public class ClaimsController : ControllerBase
{
    [HttpGet]
    public IActionResult ListClaims()
    {
        return Ok(new[] {
            new ClaimRecord("clm-100", "Orthopedic Review", "pending"),
            new ClaimRecord("clm-101", "Cardiology Follow Up", "approved")
        });
    }

    [HttpGet("{claimId}")]
    public IActionResult GetClaim(string claimId)
    {
        return Ok(new ClaimRecord("clm-100", "Orthopedic Review", "pending"));
    }

    [HttpPost]
    public IActionResult CreateClaim([FromBody] ClaimRecord claim)
    {
        if (string.IsNullOrWhiteSpace(claim.ClaimId) || string.IsNullOrWhiteSpace(claim.Member))
        {
            return BadRequest(new { error = "claimId and member are required" });
        }
        return Created($"/api/claims/{claim.ClaimId}", claim);
    }
}

public record ClaimRecord(string ClaimId, string Member, string Status);
